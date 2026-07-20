import {
  asRecord,
  FfmpegInputError,
  type GenerationArtifact,
  type GenerationCall,
  type GenerationOutput,
  generationResultSchema,
  type JsonRpcRequest,
  parseGenerationCall,
  type ToolResult,
} from "./contracts.ts"
import { FfmpegExecutionError } from "./executor.ts"

const protocolVersion = "2025-03-26"
const maximumRequestBytes = 1024 * 1024

interface GenerationExecutor {
  generate(call: GenerationCall, signal: AbortSignal): Promise<GenerationArtifact[]>
}

interface ToolDefinition {
  description: string
  inputSchema: Record<string, unknown>
  name: string
  output: GenerationOutput
}

const generationCallProperties = {
  arguments_json: {
    description:
      "JSON array of FFmpeg argv strings. Use exact {{input:N}} and {{output}} path placeholders; do not include ffmpeg itself or shell quoting.",
    maxLength: 4_096,
    minLength: 2,
    title: "FFmpeg arguments (JSON)",
    type: "string",
  },
  operation_id: { maxLength: 256, minLength: 1, type: "string" },
  output_directory: { maxLength: 4_096, minLength: 1, type: "string" },
  output_name: {
    description: "Portable output basename with an extension compatible with the selected tool.",
    maxLength: 128,
    minLength: 3,
    title: "Output file name",
    type: "string",
  },
  prompt: { maxLength: 20_000, minLength: 1, type: "string" },
  references: { items: { type: "object" }, maxItems: 16, type: "array" },
  schema: { const: "convax.generation-call/1", type: "string" },
} as const

function tool(name: string, output: GenerationOutput, description: string): ToolDefinition {
  return {
    description,
    inputSchema: {
      additionalProperties: false,
      properties: {
        ...generationCallProperties,
        output: { const: output, type: "string" },
      },
      required: [
        "schema",
        "operation_id",
        "prompt",
        "output",
        "output_directory",
        "references",
        "arguments_json",
        "output_name",
      ],
      type: "object",
    },
    name,
    output,
  }
}

export const tools = [
  tool("run.image", "image", "Run scoped FFmpeg argv and return one image artifact."),
  tool("run.video", "video", "Run scoped FFmpeg argv and return one video artifact."),
  tool("run.audio", "audio", "Run scoped FFmpeg argv and return one audio artifact."),
] as const

const toolsByName: ReadonlyMap<string, ToolDefinition> = new Map(tools.map((item) => [item.name, item]))

function isJsonRpcRequest(value: unknown): value is JsonRpcRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  return record.jsonrpc === "2.0" && typeof record.method === "string"
}

function publicError(error: unknown) {
  if (error instanceof FfmpegInputError) return error.publicMessage
  if (error instanceof DOMException && error.name === "AbortError") return "FFmpeg transform was cancelled."
  if (error instanceof FfmpegExecutionError) return "FFmpeg transform failed."
  return "FFmpeg transform failed."
}

export class McpServer {
  readonly #handlers = new Set<Promise<void>>()
  readonly #inflight = new Map<number | string, AbortController>()
  #closed = false
  #reader: ReadableStreamDefaultReader<Uint8Array> | undefined

  constructor(
    private readonly engine: GenerationExecutor,
    private readonly writeLine: (line: string) => void = (line) => { void Bun.stdout.write(line) },
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
        ? value.params as Record<string, unknown>
        : {}
      const requestId = params.requestId
      if (typeof requestId === "number" || typeof requestId === "string") {
        this.#inflight.get(requestId)?.abort("Request was cancelled")
      }
      return
    }
    if (value.id === undefined || value.id === null) return
    if (value.method === "initialize") {
      const params = asRecord(value.params, "initialize params")
      if (params.protocolVersion !== protocolVersion) {
        this.#sendError(value.id, -32602, "Unsupported MCP protocol version")
        return
      }
      this.#sendResult(value.id, {
        capabilities: { tools: {} },
        protocolVersion,
        serverInfo: { name: "convax-ffmpeg-mcp", version: "0.1.0" },
      })
      return
    }
    if (value.method === "tools/list") {
      this.#sendResult(value.id, { tools: tools.map(({ output: _output, ...definition }) => definition) })
      return
    }
    if (value.method === "tools/call") {
      await this.#callTool({ ...value, id: value.id })
      return
    }
    this.#sendError(value.id, -32601, "Method not found")
  }

  async #callTool(request: JsonRpcRequest & { id: number | string }) {
    const controller = new AbortController()
    this.#inflight.set(request.id, controller)
    try {
      const params = asRecord(request.params, "tools/call params")
      const selected = typeof params.name === "string" ? toolsByName.get(params.name) : undefined
      if (!selected) {
        this.#sendError(request.id, -32602, "Unknown tool")
        return
      }
      const call = parseGenerationCall(params.arguments, selected.output)
      const artifacts = await this.engine.generate(call, controller.signal)
      const result: ToolResult = {
        content: [{
          type: "text",
          text: `Created ${artifacts.length} local FFmpeg artifact${artifacts.length === 1 ? "" : "s"}.`,
        }],
        structuredContent: { artifacts, schema: generationResultSchema },
      }
      this.#sendResult(request.id, result)
    } catch (error) {
      const cancelled = controller.signal.aborted || error instanceof DOMException && error.name === "AbortError"
      console.error(cancelled ? "[ffmpeg] transform cancelled" : "[ffmpeg] transform failed")
      this.#sendResult(request.id, {
        content: [{ type: "text", text: publicError(error) }],
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
