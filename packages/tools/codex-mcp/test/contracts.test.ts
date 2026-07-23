import { describe, expect, test } from "bun:test"
import path from "node:path"
import { codexLlmModels, parseGenerationCall } from "../src/contracts.ts"

function call(overrides: Record<string, unknown> = {}) {
  return {
    operation_id: "operation-1",
    output: "image",
    output_directory: path.resolve("/tmp/convax-codex-output"),
    prompt: "Create a quiet landscape",
    references: [],
    schema: "convax.generation-call/1",
    ...overrides,
  }
}

describe("Codex companion contracts", () => {
  test("declares the exact current GPT-5.6 and GPT-5.5 catalog", () => {
    expect(codexLlmModels.map((model) => model.id)).toEqual([
      "gpt-5.6-sol",
      "gpt-5.6-terra",
      "gpt-5.6-luna",
      "gpt-5.5",
    ])
  })

  test("accepts bounded image calls and staged image references", () => {
    expect(parseGenerationCall(call({
      references: [{
        kind: "file",
        mime_type: "image/png",
        name: "reference.png",
        node_id: "node-1",
        path: path.resolve("/tmp/reference.png"),
        role: "reference_image",
      }],
    }))).toMatchObject({ output: "image", references: [{ role: "reference_image" }] })
  })

  test("rejects non-image references, relative paths, and unsupported fields", () => {
    expect(() => parseGenerationCall(call({ output_directory: "relative" }))).toThrow("absolute")
    expect(() => parseGenerationCall(call({ references: [{
      kind: "file",
      mime_type: "video/mp4",
      name: "video.mp4",
      node_id: "node-1",
      path: path.resolve("/tmp/video.mp4"),
      role: "reference_image",
    }] }))).toThrow("invalid")
    expect(() => parseGenerationCall(call({ provider: "private" }))).toThrow("unsupported")
  })
})
