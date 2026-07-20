import { describe, expect, test } from "bun:test"

import type { GenerationArtifact, GenerationCall } from "../src/contracts.ts"
import { McpServer, tools } from "../src/mcp-server.ts"

class FakeEngine {
  calls: GenerationCall[] = []

  async generate(call: GenerationCall): Promise<GenerationArtifact[]> {
    this.calls.push(call)
    return [{ mimeType: "image/png", name: "frame.png", path: "frame.png" }]
  }
}

async function until(predicate: () => boolean) {
  const started = Date.now()
  while (!predicate()) {
    if (Date.now() - started > 2_000) throw new Error("MCP response timed out")
    await Bun.sleep(1)
  }
}

describe("FFmpeg MCP server", () => {
  test("advertises only the three generation tools and returns the result schema", async () => {
    expect(tools.map((tool) => tool.name)).toEqual(["run.image", "run.video", "run.audio"])
    for (const tool of tools) {
      const schema = tool.inputSchema as { properties: Record<string, unknown>; required: string[] }
      expect(schema.properties).toHaveProperty("arguments_json")
      expect(schema.properties).toHaveProperty("output_name")
      expect(schema.required).toContain("arguments_json")
      expect(schema.required).toContain("output_name")
    }

    const engine = new FakeEngine()
    const lines: Record<string, unknown>[] = []
    const server = new McpServer(engine, (line) => lines.push(JSON.parse(line) as Record<string, unknown>))
    const stream = new TransformStream<Uint8Array, Uint8Array>()
    const running = server.run(stream.readable)
    const writer = stream.writable.getWriter()
    const encoder = new TextEncoder()
    await writer.write(encoder.encode(`${JSON.stringify({
      id: 1,
      jsonrpc: "2.0",
      method: "initialize",
      params: { protocolVersion: "2025-03-26" },
    })}\n`))
    await writer.write(encoder.encode(`${JSON.stringify({
      id: 2,
      jsonrpc: "2.0",
      method: "tools/call",
      params: {
        name: "run.image",
        arguments: {
          arguments_json: '["-i","{{input:0}}","{{output}}"]',
          operation_id: "frame-1",
          output: "image",
          output_directory: "/private/output",
          output_name: "frame.png",
          prompt: "Extract a frame",
          references: [{
            kind: "file",
            mime_type: "video/mp4",
            name: "source.mp4",
            node_id: "video-1",
            path: "/private/staged/source.mp4",
            role: "reference_video",
          }],
          schema: "convax.generation-call/1",
        },
      },
    })}\n`))
    await until(() => lines.length === 2)
    await writer.close()
    await running
    expect(lines[0]).toMatchObject({ result: { serverInfo: { name: "convax-ffmpeg-mcp", version: "0.1.0" } } })
    expect(lines[1]).toMatchObject({
      result: {
        structuredContent: {
          artifacts: [{ path: "frame.png" }],
          schema: "convax.generation-result/1",
        },
      },
    })
    expect(engine.calls).toHaveLength(1)
  })

  test("returns an error for malformed initialize params and keeps serving", async () => {
    const lines: Record<string, unknown>[] = []
    const server = new McpServer(new FakeEngine(), (line) => lines.push(JSON.parse(line) as Record<string, unknown>))
    const stream = new TransformStream<Uint8Array, Uint8Array>()
    const running = server.run(stream.readable)
    const writer = stream.writable.getWriter()
    const encoder = new TextEncoder()
    await writer.write(encoder.encode(`${JSON.stringify({
      id: 1,
      jsonrpc: "2.0",
      method: "initialize",
      params: null,
    })}\n`))
    await writer.write(encoder.encode(`${JSON.stringify({
      id: 2,
      jsonrpc: "2.0",
      method: "initialize",
      params: { protocolVersion: "2025-03-26" },
    })}\n`))
    await until(() => lines.length === 2)
    await writer.close()
    await running
    expect(lines).toContainEqual(expect.objectContaining({
      error: { code: -32602, message: "Invalid params" },
      id: 1,
    }))
    expect(lines).toContainEqual(expect.objectContaining({
      id: 2,
      result: expect.objectContaining({ protocolVersion: "2025-03-26" }),
    }))
  })
})
