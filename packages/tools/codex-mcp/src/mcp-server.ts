import { asRecord, codexImageToolId, parseGenerationCall, type JsonRpcRequest, type ToolResult } from "./contracts.ts"
import { CodexChatRunner } from "./chat-completions.ts"
import { CodexImageGenerator } from "./image-generator.ts"
import { CodexLlmGateway } from "./llm-gateway.ts"
import { CodexPluginService } from "./plugin-service.ts"
import type { CodexRuntime } from "./runtime.ts"

const protocolVersion = "2025-03-26"
const maximumRequestBytes = 64 * 1024 * 1024

const emptyInputSchema = { additionalProperties: false, properties: {}, type: "object" } as const

export const tools = [
  {
    description: "Generate or edit one image through local Codex GPT Image 2.",
    inputSchema: {
      additionalProperties: false,
      properties: {
        operation_id: { maxLength: 256, minLength: 1, type: "string" },
        output: { const: "image", type: "string" },
        output_directory: { maxLength: 4_096, minLength: 1, type: "string" },
        prompt: { maxLength: 20_000, minLength: 1, type: "string" },
        references: { items: { type: "object" }, maxItems: 16, type: "array" },
        schema: { const: "convax.generation-call/1", type: "string" },
      },
      required: ["schema", "operation_id", "prompt", "output", "output_directory", "references"],
      type: "object",
    },
    name: codexImageToolId,
  },
  {
    description: "Report bounded local Codex binding, account, credit, usage, model, and image-capability status.",
    inputSchema: emptyInputSchema,
    name: "service.status",
  },
  {
    description: "Probe and bind the existing local Codex installation and account without changing Codex login state.",
    inputSchema: emptyInputSchema,
    name: "service.authorize",
  },
  {
    description: "Re-probe the existing local Codex installation and account without changing Codex login state.",
    inputSchema: emptyInputSchema,
    name: "service.reauthorize",
  },
  {
    description: "Start the authenticated loopback OpenAI-compatible gateway backed by local Codex.",
    inputSchema: emptyInputSchema,
    name: "llm.gateway.start",
  },
] as const

const toolNames = new Set(tools.map((tool) => tool.name))
const serviceToolNames = new Set(["service.status", "service.authorize", "service.reauthorize"])

function isJsonRpcRequest(value: unknown): value is JsonRpcRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  return record.jsonrpc === "2.0" && typeof record.method === "string"
}

export interface McpServerOptions {
  send?: (value: unknown) => void
}

export class McpServer {
  readonly #handlers = new Set<Promise<void>>()
  readonly #inflight = new Map<number | string, AbortController>()
  readonly #runtime: CodexRuntime
  readonly #sendValue: (value: unknown) => void
  readonly #service: CodexPluginService
  #closed = false
  #gateway: CodexLlmGateway | undefined
  #reader: ReadableStreamDefaultReader<Uint8Array> | undefined

  constructor(runtime: CodexRuntime, options: McpServerOptions = {}) {
    this.#runtime = runtime
    this.#service = new CodexPluginService(runtime)
    this.#sendValue = options.send ?? ((value) => { Bun.stdout.write(`${JSON.stringify(value)}\n`) })
  }

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
          try {
            this.#dispatch(JSON.parse(line) as unknown)
          } catch {
            this.#sendError(null, -32_700, "Parse error")
          }
        }
      }
    } finally {
      this.close()
      if (this.#reader === reader) this.#reader = undefined
      reader.releaseLock()
    }
  }

  #dispatch(value: unknown) {
    const handler = this.#handle(value)
    this.#handlers.add(handler)
    void handler.finally(() => this.#handlers.delete(handler))
  }

  async #handle(value: unknown) {
    if (this.#closed) return
    if (!isJsonRpcRequest(value)) {
      this.#sendError(null, -32_600, "Invalid Request")
      return
    }
    if (value.method === "notifications/initialized") return
    if (value.method === "notifications/cancelled") {
      const requestId = (value.params && typeof value.params === "object" && !Array.isArray(value.params)
        ? value.params as Record<string, unknown>
        : {}).requestId
      if (typeof requestId === "number" || typeof requestId === "string") {
        this.#inflight.get(requestId)?.abort("Request was cancelled")
      }
      return
    }
    if (value.id === undefined || value.id === null) return
    if (value.method === "initialize") {
      const params = asRecord(value.params, "initialize params")
      if (params.protocolVersion !== protocolVersion) {
        this.#sendError(value.id, -32_602, "Unsupported MCP protocol version")
        return
      }
      this.#sendResult(value.id, {
        capabilities: { tools: {} },
        protocolVersion,
        serverInfo: { name: "convax-codex-mcp", version: "0.1.1" },
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
    this.#sendError(value.id, -32_601, "Method not found")
  }

  async #callTool(request: JsonRpcRequest & { id: number | string }) {
    const controller = new AbortController()
    this.#inflight.set(request.id, controller)
    try {
      const params = asRecord(request.params, "tools/call params")
      if (typeof params.name !== "string" || !toolNames.has(params.name as typeof tools[number]["name"])) {
        this.#sendError(request.id, -32_602, "Unknown tool")
        return
      }
      if (serviceToolNames.has(params.name)) {
        const input = asRecord(params.arguments ?? {}, "service tool arguments")
        if (Object.keys(input).length !== 0) {
          this.#sendError(request.id, -32_602, "This service tool does not accept arguments")
          return
        }
        const structuredContent = params.name === "service.status"
          ? await this.#service.status()
          : params.name === "service.authorize"
            ? await this.#service.authorize()
            : await this.#service.reauthorize()
        if (params.name !== "service.status") {
          this.#gateway?.close()
          this.#gateway = undefined
        }
        this.#sendResult(request.id, {
          content: [{ text: "Local Codex binding inspected.", type: "text" }],
          structuredContent,
        } satisfies ToolResult)
        return
      }
      if (params.name === "llm.gateway.start") {
        const input = asRecord(params.arguments ?? {}, "LLM gateway arguments")
        if (Object.keys(input).length !== 0) {
          this.#sendError(request.id, -32_602, "The LLM gateway tool does not accept arguments")
          return
        }
        const client = await this.#runtime.client()
        this.#gateway ??= new CodexLlmGateway(new CodexChatRunner(client))
        this.#sendResult(request.id, {
          content: [{ text: "Local Codex LLM gateway started.", type: "text" }],
          structuredContent: await this.#gateway.start(),
        } satisfies ToolResult)
        return
      }
      const call = parseGenerationCall(params.arguments)
      const artifacts = await new CodexImageGenerator(await this.#runtime.client()).generate(call, controller.signal)
      this.#sendResult(request.id, {
        content: [{ text: `Generated ${artifacts.length} image artifact${artifacts.length === 1 ? "" : "s"}.`, type: "text" }],
        structuredContent: { artifacts },
      } satisfies ToolResult)
    } catch {
      const cancelled = controller.signal.aborted
      console.error(cancelled ? "[codex] request cancelled" : "[codex] request failed")
      this.#sendResult(request.id, {
        content: [{ text: cancelled ? "Local Codex request was cancelled." : "Local Codex request failed.", type: "text" }],
        isError: true,
      } satisfies ToolResult)
    } finally {
      this.#inflight.delete(request.id)
    }
  }

  #sendResult(id: number | string, result: unknown) {
    this.#sendValue({ id, jsonrpc: "2.0", result })
  }

  #sendError(id: number | string | null, code: number, message: string) {
    this.#sendValue({ error: { code, message }, id, jsonrpc: "2.0" })
  }

  close() {
    if (this.#closed) return
    this.#closed = true
    for (const controller of this.#inflight.values()) controller.abort("MCP server is closing")
    this.#gateway?.close()
    this.#runtime.close()
    void this.#reader?.cancel().catch(() => undefined)
  }

  async shutdown(gracePeriodMs: number) {
    if (!Number.isFinite(gracePeriodMs) || gracePeriodMs <= 0) throw new Error("MCP shutdown grace period must be positive")
    this.close()
    if (this.#handlers.size === 0) return true
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      return await Promise.race([
        Promise.allSettled([...this.#handlers]).then(() => true),
        new Promise<false>((resolve) => { timer = setTimeout(() => resolve(false), gracePeriodMs) }),
      ])
    } finally {
      if (timer) clearTimeout(timer)
    }
  }
}
