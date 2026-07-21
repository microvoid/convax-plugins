import { describe, expect, test } from "bun:test"

import { resolveFfmpegArguments } from "../src/argument-policy.ts"
import type { FileGenerationReference } from "../src/contracts.ts"

const references: FileGenerationReference[] = [{
  kind: "file",
  mime_type: "video/mp4",
  name: "source.mp4",
  node_id: "video-1",
  path: "/private/staged/source.mp4",
  role: "reference_video",
}]

function resolve(tokens: string[]) {
  return resolveFfmpegArguments(JSON.stringify(tokens), references, "/private/output/result.mp4").argv
}

describe("FFmpeg argument policy", () => {
  test("replaces exact placeholders and permits FFmpeg mathematical divisions", () => {
    expect(resolve([
      "-i",
      "{{input:0}}",
      "-vf",
      "crop=iw/2:ih / 2,scale=16/9*ih:ih",
      "{{output}}",
    ])).toEqual([
      "-i",
      "/private/staged/source.mp4",
      "-vf",
      "crop=iw/2:ih / 2,scale=16/9*ih:ih",
      "/private/output/result.mp4",
    ])
  })

  test("permits dotted metadata and general filter expressions that do not open files", () => {
    expect(resolve([
      "-i",
      "{{input:0}}",
      "-metadata",
      "artist=Jane.Doe",
      "-vf",
      "scale=(iw+ih)/2:trunc(ih/2)*2",
      "{{output}}",
    ])).toContain("artist=Jane.Doe")
  })

  test.each([
    [["-i", "/etc/passwd", "{{output}}"], "exact {{input:N}}"],
    [["-i", "dir/source.mp4", "{{output}}"], "exact {{input:N}}"],
    [["-i", "{{input:0}}", "dir/output.mp4", "{{output}}"], "relative path"],
    [["-i", "{{input:0}}", "dir\\output.mp4", "{{output}}"], "path separators"],
    [["-i", "{{input:0}}", "https://example.test/out.mp4", "{{output}}"], "URLs"],
    [["-i", "{{input:0}}", "pipe:1", "{{output}}"], "URLs"],
    [["-i", "{{input:0}}", "-", "{{output}}"], "pipe operands"],
    [["-i", "{{input:0}}", "-pass", "1", "{{output}}"], "not allowed"],
    [["-i", "{{input:0}}", "-fs", "1G", "{{output}}"], "not allowed"],
    [["-i", "{{input:0}}", "-pre", "ambient-preset", "{{output}}"], "not allowed"],
    [["-i", "{{input:0}}", "-vpre", "ambient-preset", "{{output}}"], "not allowed"],
    [["-enable_drefs", "1", "-i", "{{input:0}}", "{{output}}"], "not allowed"],
    [["-use_absolute_path", "1", "-i", "{{input:0}}", "{{output}}"], "not allowed"],
    [["-i", "{{input:0}}", "-stats_enc_post", "stats.log", "{{output}}"], "not allowed"],
    [["-filter_complex_script", "{{input:0}}", "{{output}}"], "not allowed"],
    [["-i", "{{input:0}}", "-vf", "[0:v]scale=640:360,movie=secret.mp4[out]", "{{output}}"], "open files"],
    [["-i", "{{input:0}}", "-vf", "[0:v]subtitles=secret.srt[out]", "{{output}}"], "open files"],
    [["-i", "{{input:0}}", "-vf", "lut3d=secret.cube", "{{output}}"], "open files"],
    [["-i", "{{input:0}}", "-vf", "drawtext=text=hello:fontfile=ambient", "{{output}}"], "open files"],
  ] as const)("rejects ambient operand %#", (tokens, message) => {
    expect(() => resolve([...tokens])).toThrow(message)
  })

  test("requires one final output and valid input indices", () => {
    expect(() => resolve(["-i", "{{input:1}}", "{{output}}"])) .toThrow("no matching Canvas reference")
    expect(() => resolve(["-i", "{{input:0}}", "{{output}}", "-map_metadata", "-1"])) .toThrow(
      "final FFmpeg argument",
    )
    expect(() => resolve(["-i", "{{input:0}}", "{{output}}", "{{output}}"])) .toThrow(
      "exactly one",
    )
  })
})
