import { describe, expect, test } from "bun:test"
import type {
  AppServerMessage,
  AppServerRequestContext,
  AppServerRequestHandler,
  CodexAppServerClient,
} from "../src/app-server-client.ts"
import { CodexChatRunner, parseChatCompletionRequest } from "../src/chat-completions.ts"

class FakeClient {
  readonly calls: Array<{ method: string; params: unknown }> = []
  readonly listeners = new Set<(message: AppServerMessage) => void>()
  readonly handlers = new Set<AppServerRequestHandler>()
  toolCall = false

  onMessage(listener: (message: AppServerMessage) => void) {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  onRequest(handler: AppServerRequestHandler) {
    this.handlers.add(handler)
    return () => this.handlers.delete(handler)
  }

  async request(method: string, params: unknown) {
    this.calls.push({ method, params })
    if (method === "model/list") return { data: [{ id: "gpt-5.6-sol" }] }
    if (method === "thread/start") return { thread: { id: "thread-1" } }
    if (method === "thread/inject_items") return {}
    if (method === "turn/interrupt") return {}
    if (method === "turn/start") {
      queueMicrotask(() => { void this.completeTurn() })
      return { turn: { id: "turn-1" } }
    }
    throw new Error(`unexpected ${method}`)
  }

  async completeTurn() {
    if (this.toolCall) {
      const request: AppServerRequestContext = {
        id: 9,
        method: "item/tool/call",
        params: { arguments: { id: "ABC" }, callId: "call-1", namespace: null, threadId: "thread-1", tool: "lookup", turnId: "turn-1" },
      }
      for (const handler of this.handlers) if ((await handler(request)).handled) break
      this.emit("turn/completed", { threadId: "thread-1", turn: { id: "turn-1", status: "interrupted" } })
      return
    }
    this.emit("item/agentMessage/delta", { delta: "hello", threadId: "thread-1", turnId: "turn-1" })
    this.emit("rawResponse/completed", {
      threadId: "thread-1",
      turnId: "turn-1",
      usage: { inputTokens: 2, outputTokens: 1, totalTokens: 3 },
    })
    this.emit("turn/completed", { threadId: "thread-1", turn: { id: "turn-1", status: "completed" } })
  }

  emit(method: string, params: unknown) {
    for (const listener of this.listeners) listener({ method, params })
  }
}

describe("Codex chat completion bridge", () => {
  test("validates model ids, messages, and dynamic tools", () => {
    expect(parseChatCompletionRequest({
      messages: [{ content: "hello", role: "user" }],
      model: "gpt-5.6-sol",
      tools: [{ function: { name: "lookup", parameters: { type: "object" } }, type: "function" }],
    })).toMatchObject({ model: "gpt-5.6-sol", tools: [{ name: "lookup" }] })
    expect(() => parseChatCompletionRequest({ messages: [{ content: "x", role: "user" }], model: "other" })).toThrow("not supported")
  })

  test("runs a read-only ephemeral Codex turn and preserves usage", async () => {
    const client = new FakeClient()
    const deltas: string[] = []
    const result = await new CodexChatRunner(client as unknown as CodexAppServerClient).complete(
      parseChatCompletionRequest({ messages: [{ content: "hello", role: "user" }], model: "gpt-5.6-sol" }),
      { onDelta: (delta) => deltas.push(delta) },
    )
    expect(result).toEqual({
      content: "hello",
      toolCalls: [],
      usage: { completion_tokens: 1, prompt_tokens: 2, total_tokens: 3 },
    })
    expect(deltas).toEqual(["hello"])
    expect(client.calls.find((call) => call.method === "thread/start")?.params).toMatchObject({
      approvalPolicy: "never",
      ephemeral: true,
      model: "gpt-5.6-sol",
      sandbox: "read-only",
    })
  })

  test("returns dynamic tool calls without executing them", async () => {
    const client = new FakeClient()
    client.toolCall = true
    const request = parseChatCompletionRequest({
      messages: [{ content: "find ABC", role: "user" }],
      model: "gpt-5.6-sol",
      tools: [{ function: { name: "lookup", parameters: { type: "object" } }, type: "function" }],
    })
    await expect(new CodexChatRunner(client as unknown as CodexAppServerClient).complete(request)).resolves.toEqual({
      content: "",
      toolCalls: [{ arguments: '{"id":"ABC"}', id: "call-1", name: "lookup" }],
    })
    expect(client.calls.some((call) => call.method === "turn/interrupt")).toBeTrue()
  })
})
