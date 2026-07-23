import { describe, expect, test } from "bun:test"
import { parseGenerationCall } from "../src/contracts.ts"

function generationCall(prompt: string, text = "reference line one\n\treference line two") {
  return {
    operation_id: "multiline-operation",
    output: "image",
    output_directory: "/tmp/convax-generation-output",
    prompt,
    references: [{
      kind: "text",
      node_id: "text-node",
      role: "text",
      text,
    }],
    schema: "convax.generation-call/1",
  }
}

describe("XiaoYunque generation call contract", () => {
  test("accepts multiline prompts and Canvas text while preserving their formatting", () => {
    const prompt = "Relight the reference image\r\nKeep the composition unchanged\tand soften the shadows"
    const text = "first line\n\tsecond line"

    expect(parseGenerationCall(generationCall(prompt, text), "image")).toMatchObject({
      prompt,
      references: [{ text }],
    })
  })

  test.each(["\u0000", "\u000b", "\u001f", "\u007f"])(
    "rejects unsafe control character %# in prompts and Canvas text",
    (character) => {
      expect(() => parseGenerationCall(generationCall(`before${character}after`), "image")).toThrow()
      expect(() => parseGenerationCall(generationCall("safe prompt", `before${character}after`), "image"))
        .toThrow()
    },
  )
})
