import { describe, expect, test } from "bun:test"

import {
  createHardSubtitleErasePlan,
  createSoftSubtitleErasePlan,
  defaultHardSubtitleRegion,
  normalizedSubtitleRegionToPixels,
  selectTranscriptionAudioStream,
  type SubtitleMediaInspection,
} from "../src/domain/erasure"

const inspection: SubtitleMediaInspection = {
  audioStreams: [
    { codec: "aac", default: false, index: 1, language: "en" },
    { codec: "aac", default: true, index: 5, language: "zh-CN" },
  ],
  durationMs: 10_000,
  height: 1080,
  subtitleStreams: [
    { codec: "mov_text", default: true, forced: false, index: 2, kind: "embedded", language: "zh-CN" },
    { codec: "subrip", default: false, forced: false, index: 3, kind: "embedded", language: "en" },
    { codec: "srt", default: false, forced: false, index: 0, kind: "sidecar" },
  ],
  width: 1920,
}

describe("subtitle erasure plans", () => {
  test("selects the default video audio stream without caller input and falls back to the first stream", () => {
    expect(selectTranscriptionAudioStream(inspection)).toMatchObject({ index: 5, language: "zh-CN" })
    expect(
      selectTranscriptionAudioStream({
        ...inspection,
        audioStreams: inspection.audioStreams.map((stream) => ({ ...stream, default: false })),
      }),
    ).toMatchObject({ index: 1, language: "en" })
    expect(() => selectTranscriptionAudioStream({ ...inspection, audioStreams: [] })).toThrow(
      "does not contain a transcribable audio track",
    )
  })

  test("selects embedded streams without treating sidecars as video streams", () => {
    expect(createSoftSubtitleErasePlan(inspection, "all")).toEqual({ mode: "soft", removeStreamIndexes: [2, 3] })
    expect(() => createSoftSubtitleErasePlan(inspection, [0])).toThrow("not available")
    expect(() => createSoftSubtitleErasePlan(inspection, [2, 2])).toThrow("unique")
  })

  test("validates a normalized hard region and converts it inside frame bounds", () => {
    expect(createHardSubtitleErasePlan(defaultHardSubtitleRegion())).toMatchObject({ mode: "hard" })
    expect(normalizedSubtitleRegionToPixels({ height: 0.2, width: 0.9, x: 0.05, y: 0.75 }, inspection)).toEqual({
      height: 216,
      width: 1728,
      x: 96,
      y: 810,
    })
    expect(() => createHardSubtitleErasePlan({ height: 0.3, width: 0.5, x: 0.6, y: 0.8 })).toThrow(
      "inside the video frame",
    )
  })
})
