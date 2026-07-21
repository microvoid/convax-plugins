import { describe, expect, test } from "bun:test"

import { exportSrt, formatSrtTimestamp, parseSrt } from "../src/domain/srt"

describe("SRT", () => {
  test("parses common comma/dot timestamps and exports deterministic CRLF-independent output", () => {
    const track = parseSrt(
      "\uFEFF1\r\n00:00:00,250 --> 00:00:01.500\r\n第一行\r\n第二行\r\n\r\n2\r\n00:00:02,000 --> 00:00:03,000 position:50%\r\nConvax\r\n",
      { id: "source", language: "zh-cn" },
    )

    expect(track.language).toBe("zh-CN")
    expect(track.cues[0]).toMatchObject({ endMs: 1_500, id: "cue_1", startMs: 250, text: "第一行\n第二行" })
    expect(exportSrt(track)).toBe(
      "1\n00:00:00,250 --> 00:00:01,500\n第一行\n第二行\n\n2\n00:00:02,000 --> 00:00:03,000\nConvax\n",
    )
    expect(exportSrt(track, { includeUtf8Bom: true, lineEnding: "crlf" })).toBe(
      "\uFEFF1\r\n00:00:00,250 --> 00:00:01,500\r\n第一行\r\n第二行\r\n\r\n2\r\n00:00:02,000 --> 00:00:03,000\r\nConvax\r\n",
    )
    expect(formatSrtTimestamp(360_000_000)).toBe("100:00:00,000")
  })

  test("keeps every accepted cue round-trippable and rejects cue-internal blank separators", () => {
    const track = parseSrt("1\n00:00:00,000 --> 00:00:01,000\nline one\nline two\n", {
      id: "source-en",
      language: "en",
    })
    expect(parseSrt(exportSrt(track), { id: "round-trip", language: "en" }).cues).toEqual(track.cues)
    expect(() =>
      exportSrt({
        ...track,
        cues: [{ ...track.cues[0]!, text: "line one\n\nline two" }],
      }),
    ).toThrow("blank subtitle lines")
  })

  test("rejects malformed, empty and backwards cues", () => {
    expect(() => parseSrt("", { id: "source", language: "en" })).toThrow("must contain cues")
    expect(() => parseSrt("one\n00:00:00,000 --> 00:00:01,000\nText", { id: "source", language: "en" })).toThrow(
      "numeric index",
    )
    expect(() => parseSrt("1\n00:00:01,000 --> 00:00:00,000\nText", { id: "source", language: "en" })).toThrow(
      "must end after",
    )
  })
})
