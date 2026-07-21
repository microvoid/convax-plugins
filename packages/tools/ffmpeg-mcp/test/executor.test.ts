import { afterEach, describe, expect, test } from "bun:test"
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import type { GenerationCall } from "../src/contracts.ts"
import { FfmpegEngine, type FfmpegExecutableResolver } from "../src/executor.ts"

const directories: string[] = []

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { force: true, recursive: true })))
})

async function fixture(scriptBody: string) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "ffmpeg-engine-test-"))
  directories.push(directory)
  const outputDirectory = path.join(directory, "output")
  await mkdir(outputDirectory)
  const executable = path.join(directory, "fake-ffmpeg")
  const inputPath = path.join(directory, "staged-source.mp4")
  const mp4 = Buffer.alloc(24)
  mp4.writeUInt32BE(24, 0)
  mp4.write("ftyp", 4, "ascii")
  mp4.write("isom", 8, "ascii")
  await writeFile(inputPath, mp4)
  await writeFile(executable, `#!/bin/sh\n${scriptBody}\n`, { mode: 0o700 })
  await chmod(executable, 0o700)
  const resolver: FfmpegExecutableResolver = async () => ({
    path: executable,
    async dispose() {},
  })
  return { directory, engine: new FfmpegEngine(resolver), inputPath, outputDirectory }
}

function call(outputDirectory: string, inputPath: string): GenerationCall {
  return {
    arguments_json: '["-ss","1.25","-i","{{input:0}}","-frames:v","1","{{output}}"]',
    operation_id: "frame-1",
    output: "image",
    output_directory: outputDirectory,
    output_name: "frame.png",
    prompt: "Extract one frame",
    references: [{
      kind: "file",
      mime_type: "video/mp4",
      name: "source.mp4",
      node_id: "video-1",
      path: inputPath,
      role: "reference_video",
    }],
    schema: "convax.generation-call/1",
  }
}

describe("FFmpeg engine", () => {
  test("spawns argv without a shell and returns one relative artifact", async () => {
    const { directory, engine, inputPath, outputDirectory } = await fixture(`
output=""
for argument in "$@"; do output="$argument"; done
for argument in "$@"; do printf '%s\\n' "$argument" >> "$(dirname "$(dirname "$output")")/argv.txt"; done
printf '\\211PNG\\r\\n\\032\\nDATA' > "$output"
`)
    const artifacts = await engine.generate(call(outputDirectory, inputPath), new AbortController().signal)
    expect(artifacts).toEqual([{ mimeType: "image/png", name: "frame.png", path: "frame.png" }])
    const argv = await readFile(path.join(directory, "argv.txt"), "utf8")
    expect(argv).toContain("-nostdin\n-hide_banner\n-y\n-protocol_whitelist\nfile\n")
    expect(argv).toContain(`-fs\n${2 * 1024 * 1024 * 1024}\n`)
    expect(argv).toContain(`${inputPath}\n`)
    expect(argv).not.toContain("{{input:")
  })

  test("cancels the active child and does not report an artifact", async () => {
    const { engine, inputPath, outputDirectory } = await fixture("sleep 10")
    const controller = new AbortController()
    const operation = engine.generate(call(outputDirectory, inputPath), controller.signal)
    setTimeout(() => controller.abort(), 25)
    await expect(operation).rejects.toMatchObject({ name: "AbortError" })
  })

  test("rejects disguised playlist inputs before starting FFmpeg", async () => {
    const { engine, inputPath, outputDirectory } = await fixture("exit 91")
    await writeFile(inputPath, "#EXTM3U\n#EXTINF:1,\nfile:///etc/passwd\n")
    await expect(engine.generate(call(outputDirectory, inputPath), new AbortController().signal)).rejects.toThrow(
      "supported host media signature",
    )
  })

  test("rejects undeclared output files", async () => {
    const { engine, inputPath, outputDirectory } = await fixture(`
output=""
for argument in "$@"; do output="$argument"; done
printf '\\211PNG\\r\\n\\032\\nDATA' > "$output"
printf 'extra' > "$(dirname "$output")/extra.bin"
`)
    await expect(engine.generate(call(outputDirectory, inputPath), new AbortController().signal)).rejects.toThrow(
      "FFmpeg transform failed",
    )
  })
})
