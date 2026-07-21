import { describe, expect, test } from "bun:test"

import {
  generationCallSchema,
  type GenerationOutput,
  type SubtitleGenerationCall,
} from "../src/contracts"
import { createSubtitleDocument } from "../src/domain"
import type { SubtitleEngine, SubtitleEngineResult } from "../src/engine"
import { McpServer, tools } from "../src/mcp-server"

const reference = {
  kind: "file",
  mime_type: "video/mp4",
  name: "source.mp4",
  node_id: "video-1",
  path: "/private/staged/source.mp4",
  role: "reference_video",
} as const

function call(output: GenerationOutput, custom: Record<string, unknown> = {}) {
  return {
    operation_id: `operation-${output}`,
    output,
    output_directory: "/private/output",
    prompt: "Process the connected video subtitles",
    references: [reference],
    schema: generationCallSchema,
    ...custom,
  }
}

function subtitleDocumentJson() {
  return JSON.stringify(
    createSubtitleDocument({
      id: "subtitles-1",
      source: { durationMs: 2_000, mediaName: "source.mp4" },
      tracks: [
        {
          cues: [{ endMs: 1_000, id: "cue-1", startMs: 0, text: "Hello" }],
          id: "source-en",
          kind: "source",
          language: "en",
        },
      ],
    }),
  )
}

class FakeEngine implements SubtitleEngine {
  calls: SubtitleGenerationCall[] = []
  fail = false

  async execute(call: SubtitleGenerationCall): Promise<SubtitleEngineResult> {
    this.calls.push(call)
    if (this.fail) throw new Error("/private/staged/source.mp4: native process secret")
    if (call.output === "text") return { output: "text", text: JSON.stringify({ operation: call.tool }) }
    if (call.output === "image") {
      return {
        artifacts: [{ mimeType: "image/png", name: "preview.png", path: "preview.png" }],
        output: "image",
      }
    }
    return {
      artifacts: [{ mimeType: "video/mp4", name: "subtitles.mp4", path: "subtitles.mp4" }],
      output: "video",
    }
  }
}

class BlockingEngine implements SubtitleEngine {
  calls: SubtitleGenerationCall[] = []
  readonly started: Promise<void>
  #markStarted!: () => void

  constructor() {
    this.started = new Promise((resolve) => {
      this.#markStarted = resolve
    })
  }

  async execute(call: SubtitleGenerationCall, signal: AbortSignal): Promise<SubtitleEngineResult> {
    this.calls.push(call)
    this.#markStarted()
    return await new Promise<SubtitleEngineResult>((_resolve, reject) => {
      const cancel = () => reject(new DOMException("Cancelled", "AbortError"))
      if (signal.aborted) cancel()
      else signal.addEventListener("abort", cancel, { once: true })
    })
  }
}

async function until(predicate: () => boolean) {
  const started = Date.now()
  while (!predicate()) {
    if (Date.now() - started > 2_000) throw new Error("MCP response timed out")
    await Bun.sleep(1)
  }
}

function harness(engine: SubtitleEngine) {
  const lines: Record<string, unknown>[] = []
  const server = new McpServer(engine, (line) => lines.push(JSON.parse(line) as Record<string, unknown>))
  const stream = new TransformStream<Uint8Array, Uint8Array>()
  const running = server.run(stream.readable)
  const writer = stream.writable.getWriter()
  const encoder = new TextEncoder()
  return {
    lines,
    running,
    send: async (value: unknown) => writer.write(encoder.encode(`${JSON.stringify(value)}\n`)),
    writer,
  }
}

function toolCall(id: number, name: string, argumentsValue: unknown) {
  return { id, jsonrpc: "2.0", method: "tools/call", params: { arguments: argumentsValue, name } }
}

describe("Subtitle Studio MCP server", () => {
  test("initializes, lists manifest-matched tools, dispatches all six, and returns generation results", async () => {
    const engine = new FakeEngine()
    const runtime = harness(engine)
    await runtime.send({
      id: 1,
      jsonrpc: "2.0",
      method: "initialize",
      params: { capabilities: {}, clientInfo: { name: "test", version: "1" }, protocolVersion: "2025-03-26" },
    })
    await runtime.send({ id: 2, jsonrpc: "2.0", method: "tools/list", params: {} })
    await runtime.send(toolCall(10, "subtitle.inspect", call("text")))
    await runtime.send(toolCall(11, "subtitle.transcribe", call("text", { language: "auto", model: "tiny" })))
    await runtime.send(toolCall(12, "subtitle.erase-soft", call("video", { stream_indexes_json: "[2]" })))
    await runtime.send(
      toolCall(
        13,
        "subtitle.preview-hard",
        call("image", { height: 0.2, timestamp_ms: 500, width: 0.8, x: 0.1, y: 0.7 }),
      ),
    )
    await runtime.send(
      toolCall(14, "subtitle.erase-hard", call("video", { height: 0.2, width: 0.8, x: 0.1, y: 0.7 })),
    )
    await runtime.send(
      toolCall(15, "subtitle.mux-soft", call("video", { subtitle_document_json: subtitleDocumentJson() })),
    )
    await until(() => runtime.lines.length === 8)
    await runtime.writer.close()
    await runtime.running

    expect(runtime.lines.find((line) => line.id === 1)).toMatchObject({
      result: { protocolVersion: "2025-03-26", serverInfo: { name: "convax-subtitle-studio-mcp", version: "0.4.0" } },
    })
    expect(runtime.lines.find((line) => line.id === 2)).toMatchObject({
      result: { tools: tools.map(({ name }) => expect.objectContaining({ name })) },
    })
    for (const id of [10, 11]) {
      expect(runtime.lines.find((line) => line.id === id)).toMatchObject({
        result: {
          content: [{ type: "text" }],
          structuredContent: { artifacts: [], schema: "convax.generation-result/1" },
        },
      })
    }
    for (const id of [12, 13, 14, 15]) {
      expect(runtime.lines.find((line) => line.id === id)).toMatchObject({
        result: {
          structuredContent: {
            artifacts: [{ path: expect.stringMatching(/\.(?:mp4|png)$/u) }],
            schema: "convax.generation-result/1",
          },
        },
      })
    }
    expect(new Set(engine.calls.map(({ tool }) => tool))).toEqual(new Set(tools.map(({ name }) => name)))
  })

  test("cancels an inflight engine call through the MCP cancellation notification", async () => {
    const engine = new BlockingEngine()
    const runtime = harness(engine)
    await runtime.send(toolCall(41, "subtitle.inspect", call("text")))
    await engine.started
    await runtime.send({
      jsonrpc: "2.0",
      method: "notifications/cancelled",
      params: { reason: "user cancelled", requestId: 41 },
    })
    await until(() => runtime.lines.length === 1)
    await runtime.writer.close()
    await runtime.running
    expect(runtime.lines[0]).toMatchObject({
      id: 41,
      result: {
        content: [{ text: "Subtitle operation was cancelled.", type: "text" }],
        isError: true,
      },
    })
    expect(engine.calls).toHaveLength(1)
  })

  test("rejects unknown and malformed tools without executing and sanitizes engine failures", async () => {
    const engine = new FakeEngine()
    engine.fail = true
    const runtime = harness(engine)
    await runtime.send(toolCall(51, "subtitle.unknown", call("text")))
    await runtime.send(toolCall(52, "subtitle.inspect", { ...call("text"), native_path: "/private/secret" }))
    await runtime.send(toolCall(53, "subtitle.inspect", call("text")))
    await until(() => runtime.lines.length === 3)
    await runtime.writer.close()
    await runtime.running

    expect(runtime.lines.find((line) => line.id === 51)).toMatchObject({
      error: { code: -32602, message: "Unknown tool" },
    })
    expect(runtime.lines.find((line) => line.id === 52)).toMatchObject({
      result: { content: [{ text: "generation call contains unsupported fields." }], isError: true },
    })
    expect(runtime.lines.find((line) => line.id === 53)).toMatchObject({
      result: { content: [{ text: "Subtitle operation failed." }], isError: true },
    })
    expect(JSON.stringify(runtime.lines)).not.toContain("/private/secret")
    expect(engine.calls).toHaveLength(1)
  })

  test("returns protocol and parameter errors while keeping the stream alive", async () => {
    const runtime = harness(new FakeEngine())
    await runtime.send({ id: 61, jsonrpc: "2.0", method: "initialize", params: null })
    await runtime.send({
      id: 62,
      jsonrpc: "2.0",
      method: "initialize",
      params: { protocolVersion: "2024-11-05" },
    })
    await runtime.send({ id: 63, jsonrpc: "2.0", method: "tools/list", params: {} })
    await until(() => runtime.lines.length === 3)
    await runtime.writer.close()
    await runtime.running
    expect(runtime.lines.find((line) => line.id === 61)).toMatchObject({
      error: { code: -32602, message: "Invalid params" },
    })
    expect(runtime.lines.find((line) => line.id === 62)).toMatchObject({
      error: { code: -32602, message: "Unsupported MCP protocol version" },
    })
    expect(runtime.lines.find((line) => line.id === 63)).toHaveProperty("result")
  })
})
