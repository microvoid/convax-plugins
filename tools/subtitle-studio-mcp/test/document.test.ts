import { describe, expect, test } from "bun:test"

import {
  createSubtitleDocument,
  parseSubtitleDocument,
  replaceSubtitleTrack,
  serializeSubtitleDocument,
  type SubtitleTrack,
} from "../src/domain/document"

const sourceTrack: SubtitleTrack = {
  cues: [
    { endMs: 1_500, id: "cue-1", startMs: 0, text: "你好" },
    { endMs: 3_000, id: "cue-2", startMs: 1_700, text: "Convax" },
  ],
  id: "source-zh",
  kind: "source",
  language: "zh-CN",
}

describe("SubtitleDocument", () => {
  test("creates, validates, serializes and revisions a portable document", () => {
    const document = createSubtitleDocument({
      id: "subtitle-1",
      source: { durationMs: 4_000, fingerprint: "sha256:123", mediaName: "source.mp4" },
      tracks: [sourceTrack],
    })
    const translated = replaceSubtitleTrack(
      document,
      {
        cues: [
          { endMs: 1_500, id: "cue-1", startMs: 0, text: "Hello" },
          { endMs: 3_000, id: "cue-2", startMs: 1_700, text: "Convax" },
        ],
        id: "target-en",
        kind: "translation",
        language: "en-US",
        sourceTrackId: "source-zh",
      },
      { createdAt: "2026-07-17T00:00:00.000Z", engine: "agent.prompt", mode: "translated" },
    )

    expect(translated.revision).toBe(1)
    expect(translated.tracks).toHaveLength(2)
    expect(JSON.parse(serializeSubtitleDocument(translated))).toEqual(translated)

    const retimed = replaceSubtitleTrack(translated, {
      ...sourceTrack,
      cues: sourceTrack.cues.map((cue) => ({ ...cue, endMs: cue.endMs + 100, startMs: cue.startMs + 100 })),
    })
    expect(retimed.tracks[1]?.cues.map((cue) => [cue.startMs, cue.endMs])).toEqual([
      [100, 1_600],
      [1_800, 3_100],
    ])
  })

  test("rejects unknown fields, invalid timing, duplicate ids and missing translation sources", () => {
    expect(() =>
      parseSubtitleDocument({
        ...createSubtitleDocument({ id: "doc", source: { durationMs: 100, mediaName: "a.mp4" } }),
        nativePath: "/private/source.mp4",
      }),
    ).toThrow("unsupported field")

    expect(() =>
      createSubtitleDocument({
        id: "doc",
        source: { durationMs: 100, mediaName: "a.mp4" },
        tracks: [{ ...sourceTrack, cues: [{ endMs: 101, id: "cue", startMs: 0, text: "outside" }] }],
      }),
    ).toThrow("exceeds media duration")

    expect(() =>
      createSubtitleDocument({
        id: "doc",
        source: { durationMs: 4_000, mediaName: "a.mp4" },
        tracks: [sourceTrack, sourceTrack],
      }),
    ).toThrow("track id is duplicated")

    expect(() =>
      createSubtitleDocument({
        id: "doc",
        source: { durationMs: 4_000, mediaName: "a.mp4" },
        tracks: [{ ...sourceTrack, id: "translated", kind: "translation", sourceTrackId: "missing" }],
      }),
    ).toThrow("does not exist")

    expect(() =>
      createSubtitleDocument({
        id: "doc",
        source: { durationMs: 4_000, mediaName: "a.mp4" },
        tracks: [
          sourceTrack,
          {
            cues: [{ endMs: 1_600, id: "cue-1", startMs: 0, text: "Hello" }],
            id: "translated",
            kind: "translation",
            language: "en",
            sourceTrackId: sourceTrack.id,
          },
        ],
      }),
    ).toThrow("changed the source cue count")
  })
})
