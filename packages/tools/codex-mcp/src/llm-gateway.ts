import { randomBytes } from "node:crypto"
import {
  completionId,
  CodexChatRunner,
  InvalidChatCompletionError,
  parseChatCompletionRequest,
  type ChatCompletionResult,
} from "./chat-completions.ts"
import { codexLlmModels, llmGatewaySchema, type LlmGatewayDescriptor } from "./contracts.ts"

const maximumRequestBytes = 8 * 1024 * 1024

function errorResponse(status: number, message: string, type: string) {
  return Response.json({ error: { message, type } }, {
    headers: { "Cache-Control": "no-store" },
    status,
  })
}

async function requestBody(request: Request) {
  const declared = request.headers.get("content-length")
  if (declared !== null) {
    const size = Number(declared)
    if (!Number.isSafeInteger(size) || size < 1 || size > maximumRequestBytes) {
      throw new InvalidChatCompletionError("request body is invalid")
    }
  }
  const bytes = new Uint8Array(await request.arrayBuffer())
  if (bytes.length === 0 || bytes.length > maximumRequestBytes) {
    throw new InvalidChatCompletionError("request body is invalid")
  }
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown
  } catch {
    throw new InvalidChatCompletionError("request body is invalid")
  }
}

function toolCalls(result: ChatCompletionResult, includeIndex = false) {
  return result.toolCalls.map((call, index) => ({
    function: { arguments: call.arguments, name: call.name },
    id: call.id,
    ...(includeIndex ? { index } : {}),
    type: "function",
  }))
}

function nonStreamingResponse(id: string, model: string, created: number, result: ChatCompletionResult) {
  return Response.json({
    choices: [{
      finish_reason: result.toolCalls.length > 0 ? "tool_calls" : "stop",
      index: 0,
      message: {
        content: result.content || null,
        role: "assistant",
        ...(result.toolCalls.length === 0 ? {} : { tool_calls: toolCalls(result) }),
      },
    }],
    created,
    id,
    model,
    object: "chat.completion",
    ...(result.usage === undefined ? {} : { usage: result.usage }),
  }, { headers: { "Cache-Control": "no-store" } })
}

function sse(value: unknown) {
  return `data: ${JSON.stringify(value)}\n\n`
}

function streamingResponse(
  id: string,
  model: string,
  created: number,
  runner: CodexChatRunner,
  input: ReturnType<typeof parseChatCompletionRequest>,
  signal: AbortSignal,
) {
  const encoder = new TextEncoder()
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let emittedContent = false
      controller.enqueue(encoder.encode(sse({
        choices: [{ delta: { role: "assistant" }, finish_reason: null, index: 0 }],
        created,
        id,
        model,
        object: "chat.completion.chunk",
      })))
      void runner.complete(input, {
        signal,
        onDelta(delta) {
          emittedContent = true
          controller.enqueue(encoder.encode(sse({
            choices: [{ delta: { content: delta }, finish_reason: null, index: 0 }],
            created,
            id,
            model,
            object: "chat.completion.chunk",
          })))
        },
      }).then((result) => {
        const delta = {
          ...(!emittedContent && result.content ? { content: result.content } : {}),
          ...(result.toolCalls.length === 0 ? {} : { tool_calls: toolCalls(result, true) }),
        }
        controller.enqueue(encoder.encode(sse({
          choices: [{ delta, finish_reason: result.toolCalls.length > 0 ? "tool_calls" : "stop", index: 0 }],
          created,
          id,
          model,
          object: "chat.completion.chunk",
          ...(input.streamIncludeUsage && result.usage ? { usage: result.usage } : {}),
        })))
        controller.enqueue(encoder.encode("data: [DONE]\n\n"))
        controller.close()
      }, () => controller.error(new Error("Local Codex completion failed")))
    },
  })
  return new Response(stream, {
    headers: {
      "Cache-Control": "no-cache, no-store",
      "Content-Type": "text/event-stream; charset=utf-8",
    },
  })
}

export class CodexLlmGateway {
  readonly #runner: CodexChatRunner
  readonly #token = randomBytes(32).toString("base64url")
  #server: Bun.Server<unknown> | undefined
  #start: Promise<LlmGatewayDescriptor> | undefined

  constructor(runner: CodexChatRunner) {
    this.#runner = runner
  }

  start() {
    return this.#start ??= this.#listen()
  }

  async #listen() {
    const server = Bun.serve({
      fetch: (request) => this.#handle(request),
      hostname: "127.0.0.1",
      maxRequestBodySize: maximumRequestBytes,
      port: 0,
    })
    this.#server = server
    return {
      api_key: this.#token,
      base_url: `http://127.0.0.1:${server.port}/v1`,
      schema: llmGatewaySchema,
    }
  }

  async #handle(request: Request) {
    try {
      const url = new URL(request.url)
      if (url.host !== `127.0.0.1:${this.#server?.port ?? 0}`) {
        return errorResponse(403, "Invalid loopback host", "invalid_request_error")
      }
      if (request.headers.get("authorization") !== `Bearer ${this.#token}`) {
        return errorResponse(401, "Invalid gateway credential", "authentication_error")
      }
      if (request.method === "GET" && url.pathname === "/v1/models" && !url.search && !url.hash) {
        return Response.json({
          data: codexLlmModels.map((model) => ({ created: 0, id: model.id, object: "model", owned_by: "codex" })),
          object: "list",
        }, { headers: { "Cache-Control": "no-store" } })
      }
      if (request.method !== "POST" || url.pathname !== "/v1/chat/completions" || url.search || url.hash) {
        return errorResponse(404, "LLM endpoint was not found", "invalid_request_error")
      }
      if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) {
        return errorResponse(415, "LLM request must be JSON", "invalid_request_error")
      }
      const input = parseChatCompletionRequest(await requestBody(request))
      const id = completionId()
      const created = Math.floor(Date.now() / 1_000)
      if (input.stream) return streamingResponse(id, input.model, created, this.#runner, input, request.signal)
      return nonStreamingResponse(id, input.model, created, await this.#runner.complete(input, {
        signal: request.signal,
      }))
    } catch (error) {
      if (request.signal.aborted) return errorResponse(499, "LLM request was cancelled", "cancelled")
      if (error instanceof InvalidChatCompletionError) {
        return errorResponse(400, error.message, "invalid_request_error")
      }
      return errorResponse(502, "Local Codex completion failed", "api_error")
    }
  }

  close() {
    this.#server?.stop(true)
    this.#server = undefined
  }
}
