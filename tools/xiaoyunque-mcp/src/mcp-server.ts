import {
  asRecord,
  type GenerationArtifact,
  type GenerationCall,
  type JsonRpcRequest,
  parseGenerationCall,
  parsePluginServiceBrowserAuthorizationCompletion,
  type PluginServiceBrowserAuthorizationCompletion,
  type PluginServiceBrowserAuthorizationRequest,
  type PluginServiceStatus,
  type ToolResult,
} from "./contracts.ts"
import { XiaoYunqueCredentialConfigurationError } from "./configuration-error.ts"
import {
  XiaoYunqueGenerationInputError,
  XiaoYunqueObservationRejectedError,
  XiaoYunqueUnsupportedImageModelError,
} from "./generator.ts"
import {
  generationToolForName,
  generationTools,
  type XiaoYunqueModel,
} from "./models.ts"
import {
  XiaoYunqueAuthenticationError,
  XiaoYunqueQueryTimeoutError,
  XiaoYunqueRequestRejectedError,
} from "./xiaoyunque-api.ts"

const protocolVersion = "2025-03-26"
const maxRequestBytes = 64 * 1024 * 1024

interface GenerationExecutor {
  generate(call: GenerationCall, model: XiaoYunqueModel, signal: AbortSignal): Promise<GenerationArtifact[]>
}

interface PluginServiceExecutor {
  authorize(signal?: AbortSignal): Promise<PluginServiceBrowserAuthorizationRequest>
  cancelAuthorization(signal?: AbortSignal): Promise<PluginServiceStatus>
  close?(): void
  completeAuthorization(
    completion: PluginServiceBrowserAuthorizationCompletion,
    signal?: AbortSignal,
  ): Promise<PluginServiceStatus>
  reauthorize(signal?: AbortSignal): Promise<PluginServiceBrowserAuthorizationRequest>
  signOut(signal?: AbortSignal): Promise<PluginServiceStatus>
  status(signal?: AbortSignal): Promise<PluginServiceStatus>
}

const generationCallProperties = {
  schema: { const: "convax.generation-call/1", type: "string" },
  operation_id: { maxLength: 256, minLength: 1, type: "string" },
  prompt: { maxLength: 20_000, minLength: 1, type: "string" },
  output: { enum: ["image", "video"], type: "string" },
  output_directory: { maxLength: 4_096, minLength: 1, type: "string" },
  references: {
    items: { type: "object" },
    maxItems: 16,
    type: "array",
  },
} as const

export const generationMcpTools = generationTools.map((tool) => ({
  description: tool.description,
  inputSchema: {
    additionalProperties: false,
    properties: { ...generationCallProperties, output: { const: tool.output, type: "string" } },
    required: ["schema", "operation_id", "prompt", "output", "output_directory", "references"],
    type: "object",
  },
  name: tool.name,
}))

export const serviceMcpTools = [
  {
    description: "Report bounded XiaoYunque account, credit, usage, and local authorization status.",
    inputSchema: { additionalProperties: false, properties: {}, type: "object" },
    name: "service.status",
  },
  {
    description: "Request a host-managed XiaoYunque browser login and whitelisted Cookie capture.",
    inputSchema: { additionalProperties: false, properties: {}, type: "object" },
    name: "service.authorize",
  },
  {
    description: "Request host-managed XiaoYunque reauthorization without replacing the current session yet.",
    inputSchema: { additionalProperties: false, properties: {}, type: "object" },
    name: "service.reauthorize",
  },
  {
    description: "Cancel the currently active XiaoYunque browser authorization, if any.",
    inputSchema: { additionalProperties: false, properties: {}, type: "object" },
    name: "service.authorization.cancel",
  },
  {
    description: "Complete the active host-managed browser authorization with its bounded Cookie envelope.",
    inputSchema: {
      additionalProperties: false,
      properties: {
        authorization_id: { maxLength: 128, minLength: 16, pattern: "^[A-Za-z0-9_-]+$", type: "string" },
        cookie_origin: { maxLength: 2_048, minLength: 1, type: "string" },
        cookies: {
          items: {
            additionalProperties: false,
            properties: {
              name: { maxLength: 128, minLength: 1, type: "string" },
              value: { maxLength: 16 * 1024, minLength: 1, type: "string" },
            },
            required: ["name", "value"],
            type: "object",
          },
          maxItems: 32,
          minItems: 1,
          type: "array",
        },
        schema: { const: "convax.plugin-service-browser-authorization-completion/1", type: "string" },
      },
      required: ["schema", "authorization_id", "cookie_origin", "cookies"],
      type: "object",
    },
    name: "service.authorization.complete",
  },
  {
    description: "Clear the local XiaoYunque browser Cookie authorization.",
    inputSchema: { additionalProperties: false, properties: {}, type: "object" },
    name: "service.sign_out",
  },
] as const

export const tools = [...generationMcpTools, ...serviceMcpTools]
const serviceToolNames: ReadonlySet<string> = new Set(serviceMcpTools.map((tool) => tool.name))

function isJsonRpcRequest(value: unknown): value is JsonRpcRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  return record.jsonrpc === "2.0" && typeof record.method === "string"
}

export function publicGenerationErrorMessage(error: unknown) {
  if (error instanceof XiaoYunqueCredentialConfigurationError) return error.publicMessage
  if (error instanceof XiaoYunqueGenerationInputError) return error.publicMessage
  if (error instanceof XiaoYunqueAuthenticationError) {
    return "XiaoYunque sign-in expired. Open Convax Services and reconnect XiaoYunque."
  }
  if (error instanceof XiaoYunqueQueryTimeoutError) {
    return "XiaoYunque accepted the generation, but repeated status checks timed out. It was not resubmitted; check XiaoYunque before starting another paid generation."
  }
  if (error instanceof XiaoYunqueObservationRejectedError) {
    return "XiaoYunque accepted the generation, but repeated status checks were rejected. It was not resubmitted; check XiaoYunque before starting another paid generation."
  }
  if (error instanceof XiaoYunqueUnsupportedImageModelError) {
    return "The selected XiaoYunque image model is no longer available. Choose another image model and try again."
  }
  if (error instanceof XiaoYunqueRequestRejectedError) {
    return "XiaoYunque did not accept this generation request. Refresh Services and try a model listed for this capability."
  }
  return "XiaoYunque generation failed."
}

export const safeGenerationDiagnosticCodes = [
  "local-setup-required",
  "local-input-rejected",
  "sign-in-expired",
  "status-check-rejected",
  "status-check-timeout",
  "unsupported-image-model",
  "upstream-envelope-rejected",
  "upstream-http-rejected",
  "upstream-request-rejected",
  "unclassified-failure",
] as const

export type SafeGenerationDiagnosticCode = typeof safeGenerationDiagnosticCodes[number]

export function safeGenerationDiagnosticCode(error: unknown): SafeGenerationDiagnosticCode {
  if (error instanceof XiaoYunqueCredentialConfigurationError) return "local-setup-required"
  if (error instanceof XiaoYunqueGenerationInputError) return "local-input-rejected"
  if (error instanceof XiaoYunqueAuthenticationError) return "sign-in-expired"
  if (error instanceof XiaoYunqueObservationRejectedError) return "status-check-rejected"
  if (error instanceof XiaoYunqueQueryTimeoutError) return "status-check-timeout"
  if (error instanceof XiaoYunqueUnsupportedImageModelError) return "unsupported-image-model"
  if (error instanceof XiaoYunqueRequestRejectedError) return error.diagnosticCode
  return "unclassified-failure"
}

export class McpServer {
  readonly #engine: GenerationExecutor
  readonly #handlers = new Set<Promise<void>>()
  readonly #inflight = new Map<number | string, AbortController>()
  readonly #service: PluginServiceExecutor
  #closed = false
  #reader: ReadableStreamDefaultReader<Uint8Array> | undefined

  constructor(engine: GenerationExecutor, service: PluginServiceExecutor) {
    this.#engine = engine
    this.#service = service
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
        if (Buffer.byteLength(buffer, "utf8") > maxRequestBytes) throw new Error("MCP request exceeded the message size limit")
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
    this.#service.close?.()
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
    const handler = this.#handle(value)
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
    const request = value
    if (request.method === "notifications/initialized") return
    if (request.method === "notifications/cancelled") {
      const params = request.params && typeof request.params === "object" && !Array.isArray(request.params)
        ? request.params as Record<string, unknown>
        : {}
      const requestId = params.requestId
      if (typeof requestId === "number" || typeof requestId === "string") {
        this.#inflight.get(requestId)?.abort("Request was cancelled")
      }
      return
    }
    if (request.id === undefined || request.id === null) return
    if (request.method === "initialize") {
      const params = asRecord(request.params, "initialize params")
      if (params.protocolVersion !== protocolVersion) {
        this.#sendError(request.id, -32602, "Unsupported MCP protocol version")
        return
      }
      this.#sendResult(request.id, {
        capabilities: { tools: {} },
        protocolVersion,
        serverInfo: { name: "convax-xiaoyunque-mcp", version: "0.2.12" },
      })
      return
    }
    if (request.method === "tools/list") {
      this.#sendResult(request.id, { tools })
      return
    }
    if (request.method === "tools/call") {
      await this.#callTool({ ...request, id: request.id })
      return
    }
    this.#sendError(request.id, -32601, "Method not found")
  }

  async #callTool(request: JsonRpcRequest & { id: number | string }) {
    const controller = new AbortController()
    this.#inflight.set(request.id, controller)
    try {
      const params = asRecord(request.params, "tools/call params")
      if (typeof params.name === "string" && serviceToolNames.has(params.name)) {
        if (controller.signal.aborted) throw new DOMException("Service action was cancelled", "AbortError")
        let structuredContent: PluginServiceBrowserAuthorizationRequest | PluginServiceStatus
        if (params.name === "service.authorization.complete") {
          structuredContent = await this.#service.completeAuthorization(
            parsePluginServiceBrowserAuthorizationCompletion(params.arguments),
            controller.signal,
          )
        } else {
          const input = asRecord(params.arguments, "service tool arguments")
          if (Object.keys(input).length !== 0) {
            this.#sendError(request.id, -32602, "This service tool does not accept arguments")
            return
          }
          structuredContent = params.name === "service.status"
            ? await this.#service.status(controller.signal)
            : params.name === "service.authorize"
              ? await this.#service.authorize(controller.signal)
              : params.name === "service.reauthorize"
                ? await this.#service.reauthorize(controller.signal)
                : params.name === "service.authorization.cancel"
                  ? await this.#service.cancelAuthorization(controller.signal)
                  : await this.#service.signOut(controller.signal)
        }
        const text = params.name === "service.status"
          ? "XiaoYunque service status inspected."
          : params.name === "service.authorize"
            ? "XiaoYunque browser authorization requested from the host."
            : params.name === "service.reauthorize"
              ? "XiaoYunque browser reauthorization requested from the host."
              : params.name === "service.authorization.cancel"
                ? "XiaoYunque browser authorization cancelled."
                : params.name === "service.authorization.complete"
                  ? "XiaoYunque browser authorization stored locally."
                  : "Local XiaoYunque browser authorization cleared."
        const result: ToolResult = {
          content: [{
            type: "text",
            text,
          }],
          structuredContent,
        }
        this.#sendResult(request.id, result)
        return
      }
      const tool = generationToolForName(params.name)
      if (!tool) {
        this.#sendError(request.id, -32602, "Unknown tool")
        return
      }
      const output = tool.output
      const call = parseGenerationCall(params.arguments, tool.output)
      const artifacts = await this.#engine.generate(call, tool.model, controller.signal)
      const result: ToolResult = {
        content: [{ type: "text", text: `Generated ${artifacts.length} ${output} artifact${artifacts.length === 1 ? "" : "s"}.` }],
        structuredContent: { artifacts },
      }
      this.#sendResult(request.id, result)
    } catch (error) {
      const serviceCall = (() => {
        try {
          const params = asRecord(request.params, "tools/call params")
          return typeof params.name === "string" && serviceToolNames.has(params.name)
        } catch {
          return false
        }
      })()
      const cancelled = controller.signal.aborted || error instanceof DOMException && error.name === "AbortError"
      console.error(cancelled
        ? `[xiaoyunque] ${serviceCall ? "service action" : "generation"} cancelled`
        : serviceCall
          ? "[xiaoyunque] service action failed"
          : `[xiaoyunque] generation failed (${safeGenerationDiagnosticCode(error)})`)
      this.#sendResult(request.id, {
        content: [{
          type: "text",
          text: serviceCall ? "XiaoYunque service action failed." : publicGenerationErrorMessage(error),
        }],
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
    if (this.#closed) return
    Bun.stdout.write(`${JSON.stringify(value)}\n`)
  }
}
