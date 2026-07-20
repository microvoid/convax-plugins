import { describe, expect, test } from "bun:test"

import { mimeTypeForOutput, parseGenerationCall } from "../src/contracts.ts"

function call(overrides: Record<string, unknown> = {}) {
  return {
    arguments_json: '["-i","{{input:0}}","{{output}}"]',
    operation_id: "operation-1",
    output: "video",
    output_directory: "/private/host-output",
    output_name: "trimmed.mp4",
    prompt: "Trim the selected video",
    references: [{
      kind: "file",
      mime_type: "video/mp4",
      name: "source.mp4",
      node_id: "video-1",
      path: "/private/staged/source.mp4",
      role: "reference_video",
    }],
    schema: "convax.generation-call/1",
    ...overrides,
  }
}

describe("generation call contract", () => {
  test("accepts bounded host fields and resolves output MIME types", () => {
    expect(parseGenerationCall(call(), "video")).toMatchObject({
      output: "video",
      output_name: "trimmed.mp4",
      references: [{ node_id: "video-1", role: "reference_video" }],
    })
    expect(mimeTypeForOutput("frame.png", "image")).toBe("image/png")
    expect(mimeTypeForOutput("sound.flac", "audio")).toBe("audio/flac")
  })

  test("rejects unknown fields, text references, and mismatched extensions", () => {
    expect(() => parseGenerationCall(call({ hidden: true }), "video")).toThrow("unsupported fields")
    expect(() => parseGenerationCall(call({
      references: [{ kind: "text", node_id: "text-1", role: "text", text: "secret" }],
    }), "video")).toThrow("unsupported fields")
    expect(() => parseGenerationCall(call({ output_name: "frame.png" }), "video")).toThrow(
      "not supported for video",
    )
    expect(() => parseGenerationCall(call({ output_name: "../escape.mp4" }), "video")).toThrow(
      "portable file basename",
    )
  })
})
