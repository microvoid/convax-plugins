import { afterEach, describe, expect, test } from "bun:test"
import type { CodexChatRunner } from "../src/chat-completions.ts"
import { CodexLlmGateway } from "../src/llm-gateway.ts"

const gateways: CodexLlmGateway[] = []

afterEach(() => {
  for (const gateway of gateways.splice(0)) gateway.close()
})

function gateway() {
  const runner = {
    async complete(_request: unknown, options: { onDelta?: (delta: string) => void } = {}) {
      options.onDelta?.("hello")
      return {
        content: "hello",
        toolCalls: [],
        usage: { completion_tokens: 1, prompt_tokens: 2, total_tokens: 3 },
      }
    },
  } as unknown as CodexChatRunner
  const value = new CodexLlmGateway(runner)
  gateways.push(value)
  return value
}

describe("Codex LLM gateway", () => {
  test("requires the random bearer token and exposes only declared models", async () => {
    const descriptor = await gateway().start()
    const denied = await fetch(`${descriptor.base_url}/models`)
    expect(denied.status).toBe(401)
    const response = await fetch(`${descriptor.base_url}/models`, {
      headers: { Authorization: `Bearer ${descriptor.api_key}` },
    })
    expect(response.status).toBe(200)
    expect((await response.json() as { data: Array<{ id: string }> }).data.map((model) => model.id)).toEqual([
      "gpt-5.6-sol",
      "gpt-5.6-terra",
      "gpt-5.6-luna",
      "gpt-5.5",
    ])
  })

  test("serves non-streaming OpenAI-compatible chat completions", async () => {
    const descriptor = await gateway().start()
    const response = await fetch(`${descriptor.base_url}/chat/completions`, {
      body: JSON.stringify({ messages: [{ content: "hi", role: "user" }], model: "gpt-5.6-sol" }),
      headers: {
        Authorization: `Bearer ${descriptor.api_key}`,
        "Content-Type": "application/json",
      },
      method: "POST",
    })
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      choices: [{ finish_reason: "stop", message: { content: "hello", role: "assistant" } }],
      model: "gpt-5.6-sol",
      object: "chat.completion",
      usage: { completion_tokens: 1, prompt_tokens: 2, total_tokens: 3 },
    })
  })

  test("serves SSE and rejects undeclared models before invoking Codex", async () => {
    const descriptor = await gateway().start()
    const headers = {
      Authorization: `Bearer ${descriptor.api_key}`,
      "Content-Type": "application/json",
    }
    const streamed = await fetch(`${descriptor.base_url}/chat/completions`, {
      body: JSON.stringify({
        messages: [{ content: "hi", role: "user" }],
        model: "gpt-5.5",
        stream: true,
        stream_options: { include_usage: true },
      }),
      headers,
      method: "POST",
    })
    expect(streamed.headers.get("content-type")).toContain("text/event-stream")
    const body = await streamed.text()
    expect(body).toContain('"content":"hello"')
    expect(body).toContain('"total_tokens":3')
    expect(body).toContain("data: [DONE]")

    const rejected = await fetch(`${descriptor.base_url}/chat/completions`, {
      body: JSON.stringify({ messages: [{ content: "hi", role: "user" }], model: "gpt-4" }),
      headers,
      method: "POST",
    })
    expect(rejected.status).toBe(400)
  })
})
