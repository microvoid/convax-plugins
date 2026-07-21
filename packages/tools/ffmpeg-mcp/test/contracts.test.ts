import { describe, expect, test } from "bun:test"

import {
  highLevelToolSpecifications,
  mimeTypeForOutput,
  parseGenerationCall,
  parseHighLevelGenerationCall,
} from "../src/contracts.ts"

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

  test("derives reviewed argv and fixed output names for high-level operations", () => {
    const trim = highLevelToolSpecifications.find((tool) => tool.name === "video.trim")!
    const parsed = parseHighLevelGenerationCall({
      operation_id: "trim-1",
      output: "video",
      output_directory: "/private/host-output",
      prompt: "Trim the selected video",
      references: call().references,
      schema: "convax.generation-call/1",
      start_seconds: 3,
      duration_seconds: 2,
    }, trim)

    expect(parsed.output_name).toBe("trimmed.mp4")
    expect(JSON.parse(parsed.arguments_json)).toEqual(expect.arrayContaining([
      "-ss", "3", "-t", "2", "h264_videotoolbox", "{{output}}",
    ]))
  })

  test("requires one video reference and bounded editor values for high-level operations", () => {
    const crop = highLevelToolSpecifications.find((tool) => tool.name === "video.crop")!
    const input = {
      operation_id: "crop-1",
      output: "video",
      output_directory: "/private/host-output",
      prompt: "Crop the selected video",
      references: call().references,
      schema: "convax.generation-call/1",
      x: 0,
      y: 0,
      width: 1280,
      height: 720,
    }
    expect(parseHighLevelGenerationCall(input, crop).output_name).toBe("cropped.mp4")
    expect(() => parseHighLevelGenerationCall({ ...input, width: 0 }, crop)).toThrow("outside the supported range")
    expect(() => parseHighLevelGenerationCall({
      ...input,
      references: [{ ...call().references[0], role: "reference_image" }],
    }, crop)).toThrow("exactly one reference_video")
  })
})
