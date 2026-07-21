import {
  asRecord,
  generationResultSchema,
  type GenerationArtifact,
  type GenerationOutput,
  type JsonRpcRequest,
  parseSubtitleGenerationCall,
  SubtitleInputError,
  subtitleToolForName,
  subtitleTools,
  type ToolResult,
} from "./contracts"
import type { SubtitleEngine, SubtitleEngineResult } from "./engine"

const protocolVersion = "2025-03-26"
const serverVersion = "0.4.0"
const maximumRequestBytes = 1024 * 1024
const maximumTextResultBytes = 2 * 1024 * 1024

function isJsonRpcRequest(value: unknown): value is JsonRpcRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  return record.jsonrpc === "2.0" && typeof record.method === "string"
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[], label: string) {
  const expected = new Set(keys)
  if (Object.keys(value).length !== expected.size || Object.keys(value).some((key) => !expected.has(key))) {
    throw new SubtitleInputError(`${label} contains unsupported fields.`)
  }
}

function portableArtifactPath(value: unknown) {
  if (
    typeof value !== "string" ||
    !value ||
    value.length > 1_024 ||
    value.includes("\\") ||
    value.startsWith("/") ||
    /^[A-Za-z]:/u.test(value) ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw new Error("Subtitle engine returned an invalid artifact path")
  }
  const segments = value.split("/")
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) {
    throw new Error("Subtitle engine returned an invalid artifact path")
  }
  return value
}

function portableArtifactName(value: unknown) {
  if (
    typeof value !== "string" ||
    !value ||
    value.length > 512 ||
    value === "." ||
    value === ".." ||
    /[\\/:*?"<>|\u0000-\u001f\u007f]/u.test(value) ||
    /[. ]$/u.test(value)
  ) {
    throw new Error("Subtitle engine returned an invalid artifact name")
  }
  return value
}

function validateArtifacts(value: unknown, output: Exclude<GenerationOutput, "text">): GenerationArtifact[] {
  if (!Array.isArray(value) || value.length !== 1) {
    throw new Error("Subtitle engine must return exactly one media artifact")
  }
  return value.map((item): GenerationArtifact => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new Error("Subtitle engine returned an invalid artifact")
    }
    const artifact = item as Record<string, unknown>
    exactKeys(artifact, ["mimeType", "name", "path"], "subtitle artifact")
    if (typeof artifact.mimeType !== "string" || !artifact.mimeType.toLowerCase().startsWith(`${output}/`)) {
      throw new Error("Subtitle engine artifact MIME type does not match its output")
    }
    return {
      mimeType: artifact.mimeType.toLowerCase(),
      name: portableArtifactName(artifact.name),
      path: portableArtifactPath(artifact.path),
    }
  })
}

function validateEngineResult(result: SubtitleEngineResult, output: GenerationOutput): ToolResult {
  if (result.output !== output) throw new Error("Subtitle engine result does not match the selected tool")
  if (result.output === "text") {
    if (
      typeof result.text !== "string" ||
      !result.text.trim() ||
      Buffer.byteLength(result.text, "utf8") > maximumTextResultBytes ||
      result.text.includes("\u0000")
    ) {
      throw new Error("Subtitle engine returned invalid text")
    }
    return {
      content: [{ type: "text", text: result.text }],
      structuredContent: { artifacts: [], schema: generationResultSchema },
    }
  }
  const artifacts = validateArtifacts(result.artifacts, result.output)
  const message = result.message
  if (
    message !== undefined &&
    (typeof message !== "string" || !message.trim() || message.length > 1_000 || /[\u0000-\u001f\u007f]/u.test(message))
  ) {
    throw new Error("Subtitle engine returned an invalid message")
  }
  return {
    content: [{ type: "text", text: message ?? "Created one local subtitle media artifact." }],
    structuredContent: { artifacts, schema: generationResultSchema },
  }
}

function publicError(error: unknown, signal: AbortSignal) {
  if (signal.aborted || error instanceof DOMException && error.name === "AbortError") {
    return "Subtitle operation was cancelled."
  }
  if (error instanceof SubtitleInputError) return error.publicMessage
  return "Subtitle operation failed."
}

export const tools = subtitleTools.map(({ output: _output, ...definition }) => definition)

export class McpServer {
  readonly #handlers = new Set<Promise<void>>()
  readonly #inflight = new Map<number | string, AbortController>()
  #closed = false
  #reader: ReadableStreamDefaultReader<Uint8Array> | undefined

  constructor(
    private readonly engine: SubtitleEngine,
    private readonly writeLine: (line: string) => void = (line) => {
      void Bun.stdout.write(line)
    },
  ) {}

  async run(input: ReadableStream<Uint8Array> = Bun.stdin.stream()) {
    if (this.#reader) throw new Error("MCP server is already running")
    let buffer = ""
    const decoder = new TextDecoder()
    const reader = input.getReader()
    this.#reader = reader
    try {
      while (!this.#closed) {
        const { done, value: chunk } = await reader.read()
        if (done || this.#closed) break
        buffer += decoder.decode(chunk, { stream: true })
        if (Buffer.byteLength(buffer, "utf8") > maximumRequestBytes) {
          throw new Error("MCP request exceeded the message size limit")
        }
        while (true) {
          const newline = buffer.indexOf("\n")
          if (newline < 0) break
          const line = buffer.slice(0, newline).trim()
          buffer = buffer.slice(newline + 1)
          if (!line) continue
          let value: unknown
          try {
            value = JSON.parse(line) as unknown
          } catch {
            this.#send({ error: { code: -32700, message: "Parse error" }, id: null, jsonrpc: "2.0" })
            continue
          }
          this.#dispatch(value)
        }
      }
    } finally {
      this.close()
      if (this.#reader === reader) this.#reader = undefined
      reader.releaseLock()
    }
  }

  close() {
    if (this.#closed) return
    this.#closed = true
    for (const controller of this.#inflight.values()) controller.abort("MCP server is closing")
    void this.#reader?.cancel().catch(() => undefined)
  }

  async shutdown(gracePeriodMs: number) {
    if (!Number.isFinite(gracePeriodMs) || gracePeriodMs <= 0) {
      throw new Error("MCP shutdown grace period must be positive")
    }
    this.close()
    const handlers = [...this.#handlers]
    if (handlers.length === 0) return true
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      return await Promise.race([
        Promise.allSettled(handlers).then(() => true),
        new Promise<false>((resolve) => {
          timer = setTimeout(() => resolve(false), gracePeriodMs)
        }),
      ])
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  #dispatch(value: unknown) {
    const handler = this.#handle(value).catch(() => {
      if (this.#closed) return
      const id = isJsonRpcRequest(value) && (typeof value.id === "number" || typeof value.id === "string")
        ? value.id
        : null
      this.#sendError(id, -32602, "Invalid params")
    })
    this.#handlers.add(handler)
    void handler.then(
      () => this.#handlers.delete(handler),
      () => this.#handlers.delete(handler),
    )
  }

  async #handle(value: unknown) {
    if (this.#closed) return
    if (!isJsonRpcRequest(value)) {
      this.#send({ error: { code: -32600, message: "Invalid Request" }, id: null, jsonrpc: "2.0" })
      return
    }
    if (value.method === "notifications/initialized") return
    if (value.method === "notifications/cancelled") {
      const params = value.params && typeof value.params === "object" && !Array.isArray(value.params)
        ? (value.params as Record<string, unknown>)
        : {}
      const requestId = params.requestId
      if (typeof requestId === "number" || typeof requestId === "string") {
        this.#inflight.get(requestId)?.abort("Request was cancelled")
      }
      return
    }
    if (value.id === undefined || value.id === null) return
    if (typeof value.id !== "number" && typeof value.id !== "string") {
      this.#send({ error: { code: -32600, message: "Invalid Request" }, id: null, jsonrpc: "2.0" })
      return
    }
    if (value.method === "initialize") {
      const params = asRecord(value.params, "initialize params")
      if (params.protocolVersion !== protocolVersion) {
        this.#sendError(value.id, -32602, "Unsupported MCP protocol version")
        return
      }
      this.#sendResult(value.id, {
        capabilities: { tools: {} },
        protocolVersion,
        serverInfo: { name: "convax-subtitle-studio-mcp", version: serverVersion },
      })
      return
    }
    if (value.method === "tools/list") {
      this.#sendResult(value.id, { tools })
      return
    }
    if (value.method === "tools/call") {
      await this.#callTool({ ...value, id: value.id })
      return
    }
    this.#sendError(value.id, -32601, "Method not found")
  }

  async #callTool(request: JsonRpcRequest & { id: number | string }) {
    if (this.#inflight.has(request.id)) {
      this.#sendError(request.id, -32600, "Request id is already in use")
      return
    }
    const controller = new AbortController()
    this.#inflight.set(request.id, controller)
    try {
      const params = asRecord(request.params, "tools/call params")
      exactKeys(params, ["arguments", "name"], "tools/call params")
      const selected = typeof params.name === "string" ? subtitleToolForName(params.name) : undefined
      if (!selected) {
        this.#sendError(request.id, -32602, "Unknown tool")
        return
      }
      const call = parseSubtitleGenerationCall(params.arguments, selected)
      const result = validateEngineResult(await this.engine.execute(call, controller.signal), selected.output)
      this.#sendResult(request.id, result)
    } catch (error) {
      const cancelled = controller.signal.aborted || error instanceof DOMException && error.name === "AbortError"
      console.error(cancelled ? "[subtitle-studio] operation cancelled" : "[subtitle-studio] operation failed")
      this.#sendResult(request.id, {
        content: [{ type: "text", text: publicError(error, controller.signal) }],
        isError: true,
      } satisfies ToolResult)
    } finally {
      this.#inflight.delete(request.id)
    }
  }

  #sendResult(id: number | string, result: unknown) {
    this.#send({ id, jsonrpc: "2.0", result })
  }

  #sendError(id: number | string | null, code: number, message: string) {
    this.#send({ error: { code, message }, id, jsonrpc: "2.0" })
  }

  #send(value: unknown) {
    if (!this.#closed) this.writeLine(`${JSON.stringify(value)}\n`)
  }
}
