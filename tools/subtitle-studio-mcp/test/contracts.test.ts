import { describe, expect, test } from "bun:test"

import {
  generationCallSchema,
  parseSubtitleGenerationCall,
  subtitleToolForName,
  subtitleTools,
  type GenerationOutput,
  type SubtitleToolName,
} from "../src/contracts"
import { createSubtitleDocument } from "../src/domain"

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
    operation_id: "operation-1",
    output,
    output_directory: "/private/output",
    prompt: "Process the connected video subtitles",
    references: [reference],
    schema: generationCallSchema,
    ...custom,
  }
}

function parse(tool: SubtitleToolName, value: unknown) {
  return parseSubtitleGenerationCall(value, subtitleToolForName(tool)!)
}

function subtitleDocumentJson() {
  return JSON.stringify(
    createSubtitleDocument({
      id: "subtitles-1",
      source: { durationMs: 2_000, fingerprint: "sha256:123", mediaName: "source.mp4" },
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

describe("Subtitle Studio generation contracts", () => {
  test("advertises the six manifest-matched tools and bounded scalar inputs", () => {
    expect(subtitleTools.map(({ name, output }) => ({ name, output }))).toEqual([
      { name: "subtitle.inspect", output: "text" },
      { name: "subtitle.transcribe", output: "text" },
      { name: "subtitle.erase-soft", output: "video" },
      { name: "subtitle.preview-hard", output: "image" },
      { name: "subtitle.erase-hard", output: "video" },
      { name: "subtitle.mux-soft", output: "video" },
    ])
    const mux = subtitleToolForName("subtitle.mux-soft")!.inputSchema as {
      properties: { subtitle_document_json: { maxLength: number; type: string } }
    }
    expect(mux.properties.subtitle_document_json).toEqual(expect.objectContaining({
      maxLength: 245_760,
      type: "string",
    }))
  })

  test("strictly parses every tool input into an engine-facing call", () => {
    expect(parse("subtitle.inspect", call("text"))).toMatchObject({ input: {}, tool: "subtitle.inspect" })
    expect(
      parse("subtitle.transcribe", call("text", { language: "zh-cn", model: "base" })),
    ).toMatchObject({ input: { language: "zh-CN", model: "base" }, tool: "subtitle.transcribe" })
    expect(
      parse("subtitle.erase-soft", call("video", { stream_indexes_json: "[3,1]" })),
    ).toMatchObject({ input: { streamIndexes: [1, 3] }, tool: "subtitle.erase-soft" })
    expect(
      parse(
        "subtitle.preview-hard",
        call("image", { height: 0.2, timestamp_ms: 1_500, width: 0.8, x: 0.1, y: 0.7 }),
      ),
    ).toMatchObject({
      input: { region: { height: 0.2, width: 0.8, x: 0.1, y: 0.7 }, timestampMs: 1_500 },
      tool: "subtitle.preview-hard",
    })
    expect(
      parse("subtitle.erase-hard", call("video", { height: 0.2, width: 0.8, x: 0.1, y: 0.7 })),
    ).toMatchObject({ input: { region: { height: 0.2, width: 0.8, x: 0.1, y: 0.7 } } })
    expect(
      parse("subtitle.mux-soft", call("video", { subtitle_document_json: subtitleDocumentJson() })),
    ).toMatchObject({ input: { document: { id: "subtitles-1", schema: "convax.subtitle/1" } } })
  })

  test("rejects envelope, reference, output, and output-directory confusion", () => {
    expect(() => parse("subtitle.inspect", { ...call("text"), native_path: "/private/secret" })).toThrow(
      "unsupported fields",
    )
    expect(() => parse("subtitle.inspect", { ...call("text"), output: "video" })).toThrow("does not match")
    expect(() => parse("subtitle.inspect", { ...call("text"), output_directory: "/private/output\nsecret" })).toThrow(
      "output_directory",
    )
    expect(() => parse("subtitle.inspect", { ...call("text"), references: [] })).toThrow("exactly one")
    expect(() =>
      parse("subtitle.inspect", {
        ...call("text"),
        references: [{ kind: "text", node_id: "text-1", role: "text", text: "/private/secret" }],
      }),
    ).toThrow("unsupported fields")
    expect(() =>
      parse("subtitle.inspect", {
        ...call("text"),
        references: [{ ...reference, mime_type: "image/png" }],
      }),
    ).toThrow("must be video")
  })

  test("rejects malformed transcription, stream, region, timestamp, and document toolInput", () => {
    expect(() => parse("subtitle.transcribe", call("text", { language: "not a tag!", model: "tiny" }))).toThrow(
      "BCP-47",
    )
    expect(() => parse("subtitle.transcribe", call("text", { language: "auto", model: "large" }))).toThrow(
      "tiny, base, or small",
    )
    expect(() =>
      parse("subtitle.erase-soft", call("video", { stream_indexes_json: "[2,2]" })),
    ).toThrow("unique")
    expect(() =>
      parse("subtitle.erase-hard", call("video", { height: 0.3, width: 0.5, x: 0.6, y: 0.8 })),
    ).toThrow("inside the video frame")
    expect(() =>
      parse(
        "subtitle.preview-hard",
        call("image", { height: 0.2, timestamp_ms: -1, width: 0.8, x: 0.1, y: 0.7 }),
      ),
    ).toThrow("timestamp_ms")
    expect(() =>
      parse("subtitle.mux-soft", call("video", { subtitle_document_json: "{}" })),
    ).toThrow("convax.subtitle/1")
    expect(() =>
      parse(
        "subtitle.mux-soft",
        call("video", {
          subtitle_document_json: JSON.stringify(
            createSubtitleDocument({ id: "empty", source: { durationMs: 1_000, mediaName: "source.mp4" } }),
          ),
        }),
      ),
    ).toThrow("non-empty subtitle track")
  })
})
