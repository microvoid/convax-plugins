import { afterEach, describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import { generationCallSchema, type FileGenerationReference, type SubtitleGenerationCall } from "../src/contracts"
import { createSubtitleDocument, parseSubtitleDocument } from "../src/domain"
import { LocalSubtitleEngine } from "../src/runtime/local-engine"
import { verifyRuntimeInventory, type RuntimeFileDescriptor } from "../src/runtime/inventory"
import type { RuntimeCommandRunner } from "../src/runtime/process"

const temporaryDirectories: string[] = []
const mp4Bytes = Buffer.from([0, 0, 0, 12, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d])

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => fs.rm(directory, { force: true, recursive: true })))
})

async function directory(prefix: string) {
  const result = await fs.mkdtemp(path.join(os.tmpdir(), prefix))
  temporaryDirectories.push(result)
  return result
}

async function runtimeFixture() {
  const rootDirectory = await directory("subtitle-local-runtime-")
  const create = async (relativePath: string, contents: string, executable = false): Promise<RuntimeFileDescriptor> => {
    const filePath = path.join(rootDirectory, relativePath)
    await fs.mkdir(path.dirname(filePath), { recursive: true })
    const bytes = Buffer.from(contents)
    await fs.writeFile(filePath, bytes)
    if (executable) await fs.chmod(filePath, 0o700)
    return { byteSize: bytes.length, relativePath, sha256: createHash("sha256").update(bytes).digest("hex") }
  }
  const [ffmpeg, ffprobe, whisper, tiny, base, small, executable, detectorModel, inpaintingModel] = await Promise.all([
    create("bin/ffmpeg", "ffmpeg", true),
    create("bin/ffprobe", "ffprobe", true),
    create("bin/whisper", "whisper", true),
    create("models/tiny.bin", "tiny"),
    create("models/base.bin", "base"),
    create("models/small.bin", "small"),
    create("bin/hard-sidecar", "hard", true),
    create("models/detector.onnx", "detector"),
    create("models/inpainting.onnx", "inpainting"),
  ])
  return await verifyRuntimeInventory({
    ffmpeg,
    ffprobe,
    hardErase: { detectorModel, executable, inpaintingModel },
    models: { base, small, tiny },
    rootDirectory,
    version: "runtime-test",
    whisper,
  })
}

function mediaProbe(input: { hardOutput?: boolean; subtitleLanguages?: string[]; subtitleStreams?: number }) {
  const subtitleStreams = input.subtitleStreams ?? input.subtitleLanguages?.length ?? 1
  return JSON.stringify({
    format: { duration: "2.000" },
    streams: [
      {
        codec_name: "h264",
        codec_tag_string: input.hardOutput ? "avc1" : undefined,
        codec_type: "video",
        height: 720,
        index: 0,
        pix_fmt: input.hardOutput ? "yuv420p" : undefined,
        width: 1280,
      },
      { codec_name: "aac", codec_type: "audio", disposition: { default: 1 }, index: 1, tags: { language: "eng" } },
      ...Array.from({ length: subtitleStreams }, (_value, index) => ({
        codec_name: "mov_text",
        codec_type: "subtitle",
        disposition: { default: index === 0 ? 1 : 0, forced: 0 },
        index: index + 2,
        tags: { language: input.subtitleLanguages?.[index] ?? "eng", title: `Track ${index + 1}` },
      })),
    ],
  })
}

function hardInputProbe() {
  return JSON.stringify({
    format: { duration: "2.000", format_name: "mov,mp4" },
    streams: [
      {
        avg_frame_rate: "30/1",
        codec_name: "h264",
        codec_type: "video",
        color_primaries: "bt709",
        color_space: "bt709",
        color_transfer: "bt709",
        disposition: { attached_pic: 0 },
        duration: "2.000",
        field_order: "progressive",
        height: 720,
        index: 0,
        nb_frames: "60",
        pix_fmt: "yuv420p",
        r_frame_rate: "30/1",
        width: 1280,
      },
      { codec_name: "aac", codec_type: "audio", index: 1 },
      { codec_name: "mov_text", codec_type: "subtitle", index: 2 },
    ],
  })
}

function fakeRunner(calls: Array<{ args: readonly string[]; executable: string }>): RuntimeCommandRunner {
  return async (executable, args, signal) => {
    if (signal.aborted) throw signal.reason
    calls.push({ args, executable })
    const kind = path.basename(executable)
    if (kind === "ffprobe") {
      const entries = args[args.indexOf("-show_entries") + 1]
      const target = args.at(-1)!
      if (entries?.includes("avg_frame_rate")) return { stderr: "", stdout: hardInputProbe() }
      if (entries?.includes("codec_tag_string")) return { stderr: "", stdout: mediaProbe({ hardOutput: true }) }
      if (target.includes("without-soft-subtitles")) return { stderr: "", stdout: mediaProbe({ subtitleStreams: 0 }) }
      if (target.includes("with-soft-subtitles")) {
        return { stderr: "", stdout: mediaProbe({ subtitleLanguages: ["eng", "zho"] }) }
      }
      return { stderr: "", stdout: mediaProbe({}) }
    }
    if (kind === "ffmpeg") {
      const output = args.at(-1)!
      if (output.endsWith(".wav")) {
        const wave = Buffer.alloc(45)
        wave.write("RIFF", 0, "ascii")
        wave.write("WAVE", 8, "ascii")
        await fs.writeFile(output, wave)
      } else if (output.endsWith(".jpg")) {
        await fs.writeFile(output, Buffer.from([0xff, 0xd8, 0xff, 0xdb]))
      } else {
        await fs.writeFile(output, mp4Bytes)
      }
      return { stderr: "", stdout: "" }
    }
    if (kind === "whisper") {
      const prefix = args[args.indexOf("-of") + 1]!
      await fs.writeFile(
        `${prefix}.json`,
        JSON.stringify({
          result: { language: "en" },
          transcription: [{ offsets: { from: 0, to: 1_000 }, text: "Hello from local Whisper" }],
        }),
      )
      return { stderr: "", stdout: "" }
    }
    throw new Error("Unexpected executable")
  }
}

async function harness(commandRunner?: RuntimeCommandRunner) {
  const inventory = await runtimeFixture()
  const sourceDirectory = await directory("subtitle-local-source-")
  const sourcePath = path.join(sourceDirectory, "source.mp4")
  await fs.writeFile(sourcePath, mp4Bytes)
  const reference: FileGenerationReference = {
    kind: "file",
    mime_type: "video/mp4",
    name: "source.mp4",
    node_id: "video-1",
    path: sourcePath,
    role: "reference_video",
  }
  const calls: Array<{ args: readonly string[]; executable: string }> = []
  const engine = new LocalSubtitleEngine({
    commandRunner: commandRunner ?? fakeRunner(calls),
    hardRunner: async (input) => {
      const outputPath = path.join(input.workDirectory, input.outputRelativePath)
      await fs.writeFile(outputPath, mp4Bytes)
      return { outputPath, outputRelativePath: input.outputRelativePath }
    },
    resolveRuntime: async () => inventory,
  })
  return { calls, engine, inventory, reference }
}

function base(reference: FileGenerationReference, outputDirectory: string) {
  return {
    operation_id: crypto.randomUUID(),
    output_directory: outputDirectory,
    prompt: "Process subtitles",
    references: [reference] as [FileGenerationReference],
    schema: generationCallSchema,
  }
}

describe("local subtitle engine", () => {
  test("inspects media and transcribes the automatically selected video audio track", async () => {
    const runtime = await harness()
    const inspectDirectory = await directory("subtitle-inspect-output-")
    const inspected = await runtime.engine.execute(
      { ...base(runtime.reference, inspectDirectory), input: {}, output: "text", tool: "subtitle.inspect" },
      new AbortController().signal,
    )
    expect(inspected.output).toBe("text")
    if (inspected.output !== "text") throw new Error("Expected text result")
    expect(JSON.parse(inspected.text)).toMatchObject({ audioStreams: [{ index: 1 }], width: 1280 })

    const transcriptionDirectory = await directory("subtitle-transcription-output-")
    const transcribed = await runtime.engine.execute(
      {
        ...base(runtime.reference, transcriptionDirectory),
        input: { language: "auto", model: "tiny" },
        output: "text",
        tool: "subtitle.transcribe",
      },
      new AbortController().signal,
    )
    if (transcribed.output !== "text") throw new Error("Expected text result")
    const document = parseSubtitleDocument(JSON.parse(transcribed.text))
    expect(document.tracks[0]?.cues[0]?.text).toBe("Hello from local Whisper")
    expect(await fs.readdir(transcriptionDirectory)).toEqual([])
    const extraction = runtime.calls.find((call) => call.executable === runtime.inventory.ffmpeg.path && call.args.includes("pcm_s16le"))
    expect(extraction?.args).toContain("0:1")
    expect(new Set(runtime.calls.map((call) => call.executable))).toEqual(
      new Set([runtime.inventory.ffmpeg.path, runtime.inventory.ffprobe.path, runtime.inventory.whisper.path]),
    )
  })

  test("creates soft-removal, region preview, and multi-track soft-subtitle MP4 outputs", async () => {
    const runtime = await harness()
    const softDirectory = await directory("subtitle-soft-output-")
    const erased = await runtime.engine.execute(
      {
        ...base(runtime.reference, softDirectory),
        input: { streamIndexes: [2] },
        output: "video",
        tool: "subtitle.erase-soft",
      },
      new AbortController().signal,
    )
    if (erased.output !== "video") throw new Error("Expected video result")
    expect(await fs.readdir(softDirectory)).toEqual([erased.artifacts[0]!.name])

    const previewDirectory = await directory("subtitle-preview-output-")
    const preview = await runtime.engine.execute(
      {
        ...base(runtime.reference, previewDirectory),
        input: { region: { height: 0.2, width: 0.8, x: 0.1, y: 0.7 }, timestampMs: 500 },
        output: "image",
        tool: "subtitle.preview-hard",
      },
      new AbortController().signal,
    )
    if (preview.output !== "image") throw new Error("Expected image result")
    expect(await fs.readdir(previewDirectory)).toEqual([preview.artifacts[0]!.name])
    expect(runtime.calls.find((call) => call.args.includes("-vf"))?.args.join(" ")).toContain("drawbox")

    const muxDirectory = await directory("subtitle-mux-output-")
    const document = createSubtitleDocument({
      id: "document-1",
      source: { durationMs: 2_000, mediaName: "source.mp4" },
      tracks: [
        {
          cues: [{ endMs: 1_000, id: "cue-1", startMs: 0, text: "Hello" }],
          id: "en",
          kind: "source",
          language: "en",
        },
        {
          cues: [{ endMs: 1_000, id: "cue-1", startMs: 0, text: "你好" }],
          id: "zh",
          kind: "translation",
          language: "zh-CN",
          sourceTrackId: "en",
        },
      ],
    })
    const muxed = await runtime.engine.execute(
      { ...base(runtime.reference, muxDirectory), input: { document }, output: "video", tool: "subtitle.mux-soft" },
      new AbortController().signal,
    )
    if (muxed.output !== "video") throw new Error("Expected video result")
    expect(await fs.readdir(muxDirectory)).toEqual([muxed.artifacts[0]!.name])
    expect(runtime.calls.find((call) => call.args.includes("mov_text"))?.args).toContain("language=zho")
  })

  test("gates and executes hard erasure only through the verified sidecar inventory", async () => {
    const runtime = await harness()
    const outputDirectory = await directory("subtitle-hard-output-")
    const result = await runtime.engine.execute(
      {
        ...base(runtime.reference, outputDirectory),
        input: { region: { height: 0.2, width: 0.8, x: 0.1, y: 0.7 } },
        output: "video",
        tool: "subtitle.erase-hard",
      },
      new AbortController().signal,
    )
    if (result.output !== "video") throw new Error("Expected video result")
    expect(await fs.readdir(outputDirectory)).toEqual([result.artifacts[0]!.name])
    expect(runtime.calls.some((call) => call.args.some((arg) => arg.includes("avg_frame_rate")))).toBe(true)
  })

  test("cleans partial outputs on native failure and cancellation", async () => {
    const calls: Array<{ args: readonly string[]; executable: string }> = []
    const baseRunner = fakeRunner(calls)
    const failing = await harness(async (executable, args, signal) => {
      const result = await baseRunner(executable, args, signal)
      if (path.basename(executable) === "ffmpeg" && args.at(-1)?.includes("without-soft-subtitles")) {
        throw new Error("simulated ffmpeg failure")
      }
      return result
    })
    const failureDirectory = await directory("subtitle-failure-output-")
    await expect(
      failing.engine.execute(
        {
          ...base(failing.reference, failureDirectory),
          input: { streamIndexes: [2] },
          output: "video",
          tool: "subtitle.erase-soft",
        },
        new AbortController().signal,
      ),
    ).rejects.toThrow("simulated ffmpeg failure")
    expect(await fs.readdir(failureDirectory)).toEqual([])

    const staleCalls: Array<{ args: readonly string[]; executable: string }> = []
    const staleBase = fakeRunner(staleCalls)
    let staleReferencePath = ""
    const stale = await harness(async (executable, args, signal) => {
      const result = await staleBase(executable, args, signal)
      if (path.basename(executable) === "ffmpeg" && args.at(-1)?.includes("without-soft-subtitles")) {
        await fs.writeFile(staleReferencePath, Buffer.concat([mp4Bytes, Buffer.from("changed")]))
      }
      return result
    })
    staleReferencePath = stale.reference.path
    const staleDirectory = await directory("subtitle-stale-output-")
    await expect(
      stale.engine.execute(
        {
          ...base(stale.reference, staleDirectory),
          input: { streamIndexes: [2] },
          output: "video",
          tool: "subtitle.erase-soft",
        },
        new AbortController().signal,
      ),
    ).rejects.toThrow("changed during processing")
    expect(await fs.readdir(staleDirectory)).toEqual([])

    let started!: () => void
    const commandStarted = new Promise<void>((resolve) => (started = resolve))
    const cancellationBaseCalls: Array<{ args: readonly string[]; executable: string }> = []
    const cancellationBase = fakeRunner(cancellationBaseCalls)
    const cancelling = await harness(async (executable, args, signal) => {
      if (path.basename(executable) !== "ffmpeg") return await cancellationBase(executable, args, signal)
      started()
      return await new Promise((_resolve, reject) => {
        const abort = () => reject(signal.reason)
        if (signal.aborted) abort()
        else signal.addEventListener("abort", abort, { once: true })
      })
    })
    const cancellationDirectory = await directory("subtitle-cancel-output-")
    const controller = new AbortController()
    const operation = cancelling.engine.execute(
      {
        ...base(cancelling.reference, cancellationDirectory),
        input: { language: "auto", model: "tiny" },
        output: "text",
        tool: "subtitle.transcribe",
      },
      controller.signal,
    )
    await commandStarted
    controller.abort(new DOMException("Cancelled transcription", "AbortError"))
    await expect(operation).rejects.toThrow("Cancelled transcription")
    expect(await fs.readdir(cancellationDirectory)).toEqual([])
  })
})
