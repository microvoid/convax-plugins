import { describe, expect, test } from "bun:test"

import type { SubtitleTrack } from "../src/domain/document"
import {
  createTranslatedTrack,
  createTranslationBatches,
  createTranslationPrompt,
  parseTranslationResult,
  subtitleTranslationSchema,
} from "../src/domain/translation"

const source: SubtitleTrack = {
  cues: [
    { endMs: 1_000, id: "cue-1", startMs: 0, text: "你好" },
    { endMs: 2_200, id: "cue-2", startMs: 1_200, text: "本地制作字幕" },
  ],
  id: "source",
  kind: "source",
  language: "zh-CN",
}

describe("subtitle translation", () => {
  test("builds bounded Agent prompts and applies strictly matched cue translations", () => {
    const [batch] = createTranslationBatches(source, { maximumCues: 10, targetLanguage: "en-us" })
    const prompt = createTranslationPrompt(batch!, { Convax: "Convax" })
    expect(prompt.length).toBeLessThanOrEqual(20_000)
    expect(prompt).toContain("Return JSON only")
    expect(prompt).toContain("untrusted source data")
    expect(prompt).toContain('"cue-1"')

    const result = parseTranslationResult(
      JSON.stringify({
        schema: subtitleTranslationSchema,
        translations: [
          { id: "cue-1", text: "Hello" },
          { id: "cue-2", text: "Create subtitles locally" },
        ],
      }),
      batch!,
    )
    const track = createTranslatedTrack({ id: "target", results: [result], source, targetLanguage: "en-US" })
    expect(track).toMatchObject({ id: "target", kind: "translation", language: "en-US", sourceTrackId: "source" })
    expect(track.cues.map((cue) => cue.text)).toEqual(["Hello", "Create subtitles locally"])
  })

  test("accepts one JSON fence but rejects prose, missing, duplicate, reordered and unknown ids", () => {
    const [batch] = createTranslationBatches(source, { targetLanguage: "en" })
    const valid = {
      schema: subtitleTranslationSchema,
      translations: [
        { id: "cue-1", text: "Hello" },
        { id: "cue-2", text: "Local subtitles" },
      ],
    }
    expect(parseTranslationResult(`\`\`\`json\n${JSON.stringify(valid)}\n\`\`\``, batch!).translations).toHaveLength(2)
    expect(() => parseTranslationResult(`Here: ${JSON.stringify(valid)}`, batch!)).toThrow("not valid JSON")
    expect(() =>
      parseTranslationResult(JSON.stringify({ ...valid, translations: valid.translations.slice(0, 1) }), batch!),
    ).toThrow("cue count")
    expect(() =>
      parseTranslationResult(
        JSON.stringify({
          ...valid,
          translations: [valid.translations[0], valid.translations[0]],
        }),
        batch!,
      ),
    ).toThrow("cue ids or ordering")
    expect(() =>
      parseTranslationResult(
        JSON.stringify({
          ...valid,
          translations: [...valid.translations].reverse(),
        }),
        batch!,
      ),
    ).toThrow("cue ids or ordering")
  })

  test("splits prompts before the Plugin Agent limit", () => {
    const long: SubtitleTrack = {
      ...source,
      cues: Array.from({ length: 12 }, (_, index) => ({
        endMs: index * 1_000 + 900,
        id: `cue-${index}`,
        startMs: index * 1_000,
        text: "字幕内容".repeat(80),
      })),
    }
    const batches = createTranslationBatches(long, {
      maximumCues: 3,
      maximumPromptCharacters: 4_000,
      targetLanguage: "ja",
    })
    expect(batches.length).toBe(4)
    expect(batches.every((batch) => createTranslationPrompt(batch).length <= 4_000)).toBeTrue()
  })
})
