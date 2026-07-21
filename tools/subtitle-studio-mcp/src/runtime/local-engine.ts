import { constants as fsConstants } from "node:fs"
import fs from "node:fs/promises"
import path from "node:path"

import type { SubtitleGenerationCall } from "../contracts"
import {
  createSoftSubtitleErasePlan,
  createSubtitleDocument,
  exportSrt,
  normalizedSubtitleRegionToPixels,
  selectTranscriptionAudioStream,
  serializeSubtitleDocument,
  type SubtitleMediaInspection,
  type SubtitleTrack,
} from "../domain"
import type { SubtitleEngine, SubtitleEngineResult } from "../engine"
import {
  createHardSubtitleEraseSidecarRunner,
  type HardSubtitleEraseSidecarRunner,
  type VerifiedHardSubtitleRuntime,
} from "./hard-runner"
import { assertRuntimeFileStable, type VerifiedSubtitleRuntimeInventory } from "./inventory"
import {
  assertH264Mp4HardEraseOutput,
  assertHardEraseP0MediaCompatibility,
  parseFfprobeInspection,
  parseWhisperJson,
} from "./media"
import { createRuntimeCommandRunner, type RuntimeCommandRunner } from "./process"

export type SubtitleRuntimeResolver = (signal: AbortSignal) => Promise<VerifiedSubtitleRuntimeInventory>

export interface LocalSubtitleEngineOptions {
  commandRunner?: RuntimeCommandRunner
  hardRunner?: HardSubtitleEraseSidecarRunner
  resolveRuntime: SubtitleRuntimeResolver
}

interface FileIdentity {
  ctimeMs: number | bigint
  dev: number | bigint
  ino: number | bigint
  mtimeMs: number | bigint
  size: number | bigint
}

interface ValidatedSource {
  identity: FileIdentity
  path: string
}

interface OutputScope {
  allocate(name: string): Promise<string>
  directory: string
  keep(filePath: string): void
}

const inspectionEntries =
  "format=duration:stream=index,codec_type,codec_name,width,height:stream_tags=language,title:stream_disposition=default,forced"
const hardInputEntries =
  "format=format_name:stream=index,codec_type,codec_name,width,height,avg_frame_rate,r_frame_rate,pix_fmt,duration,nb_frames,field_order,color_space,color_transfer,color_primaries:stream_tags=rotate:stream_disposition=attached_pic:stream_side_data=rotation"
const hardOutputEntries =
  "format=duration:stream=index,codec_type,codec_name,codec_tag_string,pix_fmt,width,height:stream_tags=language,title:stream_disposition=default,forced"

export class LocalSubtitleEngine implements SubtitleEngine {
  private readonly commandRunner: RuntimeCommandRunner
  private readonly hardRunner: HardSubtitleEraseSidecarRunner

  constructor(private readonly options: LocalSubtitleEngineOptions) {
    this.commandRunner = options.commandRunner ?? createRuntimeCommandRunner()
    this.hardRunner = options.hardRunner ?? createHardSubtitleEraseSidecarRunner()
  }

  async execute(call: SubtitleGenerationCall, signal: AbortSignal): Promise<SubtitleEngineResult> {
    throwIfAborted(signal)
    const source = await validateSource(call.references[0].path)
    const inventory = await this.options.resolveRuntime(signal)
    const scopeState = await createOutputScope(call.output_directory)
    const scope = scopeState.scope
    try {
      const result = await this.dispatch(call, source, scope, inventory, signal)
      await assertSourceStable(source)
      await scopeState.assertStable()
      scopeState.commit()
      return result
    } finally {
      await scopeState.cleanup()
    }
  }

  private async dispatch(
    call: SubtitleGenerationCall,
    source: ValidatedSource,
    scope: OutputScope,
    inventory: VerifiedSubtitleRuntimeInventory,
    signal: AbortSignal,
  ): Promise<SubtitleEngineResult> {
    if (call.tool === "subtitle.inspect") {
      const inspection = await this.inspect(source.path, inventory, signal)
      return { output: "text", text: `${JSON.stringify(inspection, null, 2)}\n` }
    }
    if (call.tool === "subtitle.transcribe") {
      return await this.transcribe(call, source, scope, inventory, signal)
    }
    if (call.tool === "subtitle.erase-soft") {
      return await this.eraseSoft(call, source, scope, inventory, signal)
    }
    if (call.tool === "subtitle.preview-hard") {
      return await this.previewHard(call, source, scope, inventory, signal)
    }
    if (call.tool === "subtitle.erase-hard") {
      return await this.eraseHard(call, source, scope, inventory, signal)
    }
    return await this.muxSoft(call, source, scope, inventory, signal)
  }

  private async inspect(sourcePath: string, inventory: VerifiedSubtitleRuntimeInventory, signal: AbortSignal) {
    await assertRuntimeFileStable(inventory.ffprobe)
    const result = await this.commandRunner(
      inventory.ffprobe.path,
      ["-v", "error", "-show_entries", inspectionEntries, "-of", "json", sourcePath],
      signal,
    )
    return parseFfprobeInspection(result.stdout)
  }

  private async transcribe(
    call: Extract<SubtitleGenerationCall, { tool: "subtitle.transcribe" }>,
    source: ValidatedSource,
    scope: OutputScope,
    inventory: VerifiedSubtitleRuntimeInventory,
    signal: AbortSignal,
  ): Promise<SubtitleEngineResult> {
    const inspection = await this.inspect(source.path, inventory, signal)
    const audioStream = selectTranscriptionAudioStream(inspection)
    const model = inventory.models[call.input.model]
    if (!model) throw new Error("Requested Whisper model is not in the verified companion runtime")
    await Promise.all([
      assertRuntimeFileStable(inventory.ffmpeg),
      assertRuntimeFileStable(inventory.whisper),
      assertRuntimeFileStable(model),
    ])
    const audioPath = await scope.allocate("transcription-audio.wav")
    await this.commandRunner(
      inventory.ffmpeg.path,
      [
        "-nostdin",
        "-hide_banner",
        "-loglevel",
        "error",
        "-n",
        "-i",
        source.path,
        "-map",
        `0:${audioStream.index}`,
        "-vn",
        "-ac",
        "1",
        "-ar",
        "16000",
        "-c:a",
        "pcm_s16le",
        audioPath,
      ],
      signal,
    )
    await requireWaveFile(audioPath)
    const jsonPath = await scope.allocate("transcription.json")
    const outputPrefix = jsonPath.slice(0, -".json".length)
    const whisperArgs = [
      "-m",
      model.path,
      "-f",
      audioPath,
      "-l",
      call.input.language,
      "-oj",
      "-of",
      outputPrefix,
      "-np",
    ]
    try {
      await this.commandRunner(inventory.whisper.path, whisperArgs, signal)
    } catch (error) {
      if (signal.aborted) throw error
      await fs.rm(jsonPath, { force: true })
      await Promise.all([assertRuntimeFileStable(inventory.whisper), assertRuntimeFileStable(model)])
      await this.commandRunner(inventory.whisper.path, [...whisperArgs, "-ng"], signal)
    }
    const transcription = await readBoundedJson(jsonPath, 32 * 1024 * 1024)
    const parsed = parseWhisperJson(transcription, call.input.language)
    const document = createSubtitleDocument({
      id: call.operation_id,
      provenance: [
        {
          createdAt: new Date().toISOString(),
          engine: "whisper.cpp",
          mode: "transcribed",
          model: `${call.input.model}@${inventory.version}`,
        },
      ],
      source: { durationMs: inspection.durationMs, mediaName: call.references[0].name },
      tracks: [parsed.track],
    })
    return { output: "text", text: serializeSubtitleDocument(document) }
  }

  private async eraseSoft(
    call: Extract<SubtitleGenerationCall, { tool: "subtitle.erase-soft" }>,
    source: ValidatedSource,
    scope: OutputScope,
    inventory: VerifiedSubtitleRuntimeInventory,
    signal: AbortSignal,
  ): Promise<SubtitleEngineResult> {
    const inspection = await this.inspect(source.path, inventory, signal)
    const plan = createSoftSubtitleErasePlan(inspection, call.input.streamIndexes)
    await assertRuntimeFileStable(inventory.ffmpeg)
    const extension = safeMediaExtension(call.references[0].name)
    const name = `${safeStem(call.references[0].name)}.without-soft-subtitles${extension}`
    const output = await scope.allocate(name)
    const remove = plan.removeStreamIndexes.flatMap((index) => ["-map", `-0:${index}`])
    await this.commandRunner(
      inventory.ffmpeg.path,
      [
        "-nostdin",
        "-hide_banner",
        "-loglevel",
        "error",
        "-n",
        "-i",
        source.path,
        "-map",
        "0",
        ...remove,
        "-map_metadata",
        "0",
        "-map_chapters",
        "0",
        "-c",
        "copy",
        output,
      ],
      signal,
    )
    await requireVideoOutput(output)
    const packaged = await this.inspect(output, inventory, signal)
    assertMediaPreserved(inspection, packaged)
    if (packaged.subtitleStreams.length !== inspection.subtitleStreams.length - plan.removeStreamIndexes.length) {
      throw new Error("Soft subtitle removal output contains unexpected subtitle streams")
    }
    scope.keep(output)
    return {
      artifacts: [{ mimeType: call.references[0].mime_type, name, path: name }],
      message: "Selected embedded subtitle streams were removed without re-encoding media.",
      output: "video",
    }
  }

  private async previewHard(
    call: Extract<SubtitleGenerationCall, { tool: "subtitle.preview-hard" }>,
    source: ValidatedSource,
    scope: OutputScope,
    inventory: VerifiedSubtitleRuntimeInventory,
    signal: AbortSignal,
  ): Promise<SubtitleEngineResult> {
    const inspection = await this.inspect(source.path, inventory, signal)
    if (call.input.timestampMs > inspection.durationMs) throw new Error("Preview timestamp exceeds media duration")
    const region = normalizedSubtitleRegionToPixels(call.input.region, inspection)
    await assertRuntimeFileStable(inventory.ffmpeg)
    const name = "hard-subtitle-region-preview.jpg"
    const output = await scope.allocate(name)
    const filter = `drawbox=x=${region.x}:y=${region.y}:w=${region.width}:h=${region.height}:color=red@0.85:t=4,scale='min(960,iw)':-2`
    await this.commandRunner(
      inventory.ffmpeg.path,
      [
        "-nostdin",
        "-hide_banner",
        "-loglevel",
        "error",
        "-n",
        "-ss",
        (call.input.timestampMs / 1_000).toFixed(3),
        "-i",
        source.path,
        "-frames:v",
        "1",
        "-vf",
        filter,
        "-q:v",
        "3",
        output,
      ],
      signal,
    )
    await requireJpegOutput(output)
    scope.keep(output)
    return { artifacts: [{ mimeType: "image/jpeg", name, path: name }], output: "image" }
  }

  private async eraseHard(
    call: Extract<SubtitleGenerationCall, { tool: "subtitle.erase-hard" }>,
    source: ValidatedSource,
    scope: OutputScope,
    inventory: VerifiedSubtitleRuntimeInventory,
    signal: AbortSignal,
  ): Promise<SubtitleEngineResult> {
    if (!inventory.hardErase) throw new Error("Verified hard-subtitle AI runtime is unavailable")
    const inspection = await this.inspect(source.path, inventory, signal)
    await assertRuntimeFileStable(inventory.ffprobe)
    const compatibility = await this.commandRunner(
      inventory.ffprobe.path,
      ["-v", "error", "-show_entries", hardInputEntries, "-of", "json", source.path],
      signal,
    )
    assertHardEraseP0MediaCompatibility(compatibility.stdout, inspection)
    const name = `${safeStem(call.references[0].name)}.hard-subtitles-removed.mp4`
    const output = await scope.allocate(name)
    const runtime: VerifiedHardSubtitleRuntime = {
      ...inventory.hardErase,
      ffmpeg: inventory.ffmpeg,
      version: inventory.version,
    }
    const result = await this.hardRunner({
      durationMs: inspection.durationMs,
      height: inspection.height,
      outputRelativePath: name,
      region: normalizedSubtitleRegionToPixels(call.input.region, inspection),
      report: () => undefined,
      runtime,
      signal,
      sourcePath: source.path,
      width: inspection.width,
      workDirectory: scope.directory,
    })
    if (result.outputPath !== output || result.outputRelativePath !== name) {
      throw new Error("Hard subtitle sidecar returned an unbound output")
    }
    await requireVideoOutput(output, true)
    await assertRuntimeFileStable(inventory.ffprobe)
    const outputProbe = await this.commandRunner(
      inventory.ffprobe.path,
      ["-v", "error", "-show_entries", hardOutputEntries, "-of", "json", output],
      signal,
    )
    assertH264Mp4HardEraseOutput(outputProbe.stdout)
    const packaged = parseFfprobeInspection(outputProbe.stdout)
    assertMediaPreserved(inspection, packaged)
    if (
      packaged.subtitleStreams.length !== inspection.subtitleStreams.length ||
      packaged.audioStreams.some((stream) => stream.codec !== "aac") ||
      packaged.subtitleStreams.some((stream) => stream.codec !== "mov_text")
    ) {
      throw new Error("Hard subtitle output failed its media gate")
    }
    scope.keep(output)
    return {
      artifacts: [{ mimeType: "video/mp4", name, path: name }],
      message: "Burned-in subtitles were processed by the verified local AI runtime.",
      output: "video",
    }
  }

  private async muxSoft(
    call: Extract<SubtitleGenerationCall, { tool: "subtitle.mux-soft" }>,
    source: ValidatedSource,
    scope: OutputScope,
    inventory: VerifiedSubtitleRuntimeInventory,
    signal: AbortSignal,
  ): Promise<SubtitleEngineResult> {
    const inspection = await this.inspect(source.path, inventory, signal)
    const durationTolerance = Math.max(1_000, Math.round(inspection.durationMs * 0.01))
    if (Math.abs(call.input.document.source.durationMs - inspection.durationMs) > durationTolerance) {
      throw new Error("Subtitle document duration does not match connected media")
    }
    const tracks = call.input.document.tracks.filter((track) => track.cues.length > 0)
    if (tracks.length === 0) throw new Error("Soft subtitle mux requires a non-empty track")
    const inputPaths: string[] = []
    let totalBytes = 0
    for (const [index, track] of tracks.entries()) {
      const content = exportSrt(track, { includeUtf8Bom: true, lineEnding: "crlf" })
      const byteSize = Buffer.byteLength(content)
      if (byteSize > 16 * 1024 * 1024) throw new Error("One subtitle track exceeds the mux limit")
      totalBytes += byteSize
      if (totalBytes > 64 * 1024 * 1024) throw new Error("Subtitle tracks exceed the mux limit")
      const subtitlePath = await scope.allocate(`subtitle-${index + 1}.srt`)
      await fs.writeFile(subtitlePath, content, { encoding: "utf8", flag: "wx" })
      inputPaths.push(subtitlePath)
    }
    const name = `${safeStem(call.references[0].name)}.with-soft-subtitles.mp4`
    const output = await scope.allocate(name)
    await assertRuntimeFileStable(inventory.ffmpeg)
    const subtitleInputs = inputPaths.flatMap((subtitlePath) => ["-f", "srt", "-i", subtitlePath])
    const subtitleMaps = inputPaths.flatMap((_subtitlePath, index) => ["-map", `${index + 1}:0`])
    const metadata = tracks.flatMap((track, index) => [
      `-metadata:s:s:${index}`,
      `language=${mp4SubtitleLanguage(track.language)}`,
      `-metadata:s:s:${index}`,
      `title=${safeSubtitleTitle(track.label ?? track.language)}`,
      `-metadata:s:s:${index}`,
      `handler_name=${safeSubtitleTitle(track.label ?? track.language)}`,
      `-disposition:s:${index}`,
      index === 0 ? "default" : "0",
    ])
    await this.commandRunner(
      inventory.ffmpeg.path,
      [
        "-nostdin",
        "-hide_banner",
        "-loglevel",
        "error",
        "-n",
        "-i",
        source.path,
        ...subtitleInputs,
        "-map",
        "0:v:0",
        "-map",
        "0:a?",
        ...subtitleMaps,
        "-map_metadata",
        "0",
        "-map_chapters",
        "0",
        "-c:v",
        "copy",
        "-c:a",
        "copy",
        "-c:s",
        "mov_text",
        ...metadata,
        "-movflags",
        "+faststart",
        "-f",
        "mp4",
        output,
      ],
      signal,
    )
    await requireVideoOutput(output, true)
    const packaged = await this.inspect(output, inventory, signal)
    assertMediaPreserved(inspection, packaged)
    if (
      packaged.subtitleStreams.length !== tracks.length ||
      packaged.subtitleStreams.some(
        (stream, index) =>
          stream.codec.toLowerCase() !== "mov_text" ||
          stream.language?.toLowerCase() !== mp4SubtitleLanguage(tracks[index]!.language) ||
          stream.default !== (index === 0) ||
          stream.forced,
      )
    ) {
      throw new Error("Embedded subtitle streams do not match the subtitle document")
    }
    scope.keep(output)
    return {
      artifacts: [{ mimeType: "video/mp4", name, path: name }],
      message: `${tracks.length} soft subtitle track${tracks.length === 1 ? "" : "s"} embedded.`,
      output: "video",
    }
  }
}

export function createLocalSubtitleEngine(options: LocalSubtitleEngineOptions): SubtitleEngine {
  return new LocalSubtitleEngine(options)
}

async function validateSource(sourcePath: string): Promise<ValidatedSource> {
  if (!path.isAbsolute(sourcePath)) throw new Error("Staged reference path must be absolute")
  const before = await fs.lstat(sourcePath)
  if (before.isSymbolicLink() || !before.isFile() || before.size < 12) {
    throw new Error("Staged reference is not a supported regular video file")
  }
  const realPath = await fs.realpath(sourcePath)
  const handle = await fs.open(realPath, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0))
  try {
    const opened = await handle.stat()
    const identity = snapshot(opened)
    if (!opened.isFile() || !sameIdentity(snapshot(before), identity)) throw new Error("Staged reference changed")
    const header = Buffer.alloc(16)
    const { bytesRead } = await handle.read(header, 0, header.length, 0)
    if (!isSupportedVideoHeader(header.subarray(0, bytesRead))) throw new Error("Staged reference media signature is unsupported")
    return { identity, path: realPath }
  } finally {
    await handle.close()
  }
}

async function assertSourceStable(source: ValidatedSource) {
  const before = await fs.lstat(source.path)
  if (before.isSymbolicLink() || !before.isFile() || !sameIdentity(source.identity, snapshot(before))) {
    throw new Error("Staged reference changed during processing")
  }
  const handle = await fs.open(source.path, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0))
  try {
    if (!sameIdentity(source.identity, snapshot(await handle.stat()))) throw new Error("Staged reference changed during processing")
  } finally {
    await handle.close()
  }
}

async function createOutputScope(outputDirectory: string) {
  if (!path.isAbsolute(outputDirectory)) throw new Error("Output directory must be absolute")
  const before = await fs.lstat(outputDirectory)
  if (before.isSymbolicLink() || !before.isDirectory()) throw new Error("Output directory is not a regular directory")
  const directory = await fs.realpath(outputDirectory)
  const identity = { dev: before.dev, ino: before.ino }
  const allocated = new Set<string>()
  const kept = new Set<string>()
  let committed = false
  const assertStable = async () => {
    const current = await fs.lstat(directory)
    if (current.isSymbolicLink() || !current.isDirectory() || current.dev !== identity.dev || current.ino !== identity.ino) {
      throw new Error("Output directory changed during processing")
    }
  }
  const scope: OutputScope = {
    allocate: async (name) => {
      const portable = portableFileName(name)
      await assertStable()
      const output = path.join(directory, portable)
      try {
        await fs.lstat(output)
        throw new Error("Output file already exists")
      } catch (error) {
        if (!isNodeError(error) || error.code !== "ENOENT") throw error
      }
      allocated.add(output)
      return output
    },
    directory,
    keep: (filePath) => {
      if (!allocated.has(filePath)) throw new Error("Cannot keep an unallocated output")
      kept.add(filePath)
    },
  }
  return {
    assertStable,
    commit: () => {
      committed = true
    },
    cleanup: async () => {
      await Promise.all(
        [...allocated].filter((file) => !committed || !kept.has(file)).map((file) => fs.rm(file, { force: true })),
      )
    },
    scope,
  }
}

function snapshot(stat: { ctimeMs: number | bigint; dev: number | bigint; ino: number | bigint; mtimeMs: number | bigint; size: number | bigint }): FileIdentity {
  return { ctimeMs: stat.ctimeMs, dev: stat.dev, ino: stat.ino, mtimeMs: stat.mtimeMs, size: stat.size }
}

function sameIdentity(left: FileIdentity, right: FileIdentity) {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs
}

function isSupportedVideoHeader(header: Buffer) {
  return (
    (header.length >= 12 && header.subarray(4, 8).toString("ascii") === "ftyp") ||
    (header.length >= 4 && header.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]))) ||
    (header.length >= 12 && header.subarray(0, 4).toString("ascii") === "RIFF" && header.subarray(8, 12).toString("ascii") === "AVI ") ||
    (header.length >= 3 && header.subarray(0, 3).toString("ascii") === "FLV")
  )
}

async function requireWaveFile(filePath: string) {
  const bytes = await readBoundedFile(filePath, 512 * 1024 * 1024, 12)
  if (bytes.length <= 44 || bytes.subarray(0, 4).toString("ascii") !== "RIFF" || bytes.subarray(8, 12).toString("ascii") !== "WAVE") {
    throw new Error("FFmpeg did not produce valid transcription audio")
  }
}

async function requireJpegOutput(filePath: string) {
  const bytes = await readBoundedFile(filePath, 4 * 1024 * 1024, 3)
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes[2] !== 0xff) throw new Error("FFmpeg did not produce a JPEG preview")
}

async function requireVideoOutput(filePath: string, requireMp4 = false) {
  const bytes = await readBoundedFile(filePath, 1024 * 1024 * 1024 * 1024, 12, 16)
  if (!isSupportedVideoHeader(bytes) || (requireMp4 && bytes.subarray(4, 8).toString("ascii") !== "ftyp")) {
    throw new Error("Media processor did not produce the required video container")
  }
}

async function readBoundedJson(filePath: string, maximumBytes: number) {
  const bytes = await readBoundedFile(filePath, maximumBytes, 2)
  try {
    return JSON.parse(bytes.toString("utf8")) as unknown
  } catch {
    throw new Error("Runtime JSON output is invalid")
  }
}

async function readBoundedFile(filePath: string, maximumBytes: number, minimumBytes: number, readBytes?: number) {
  const before = await fs.lstat(filePath)
  if (before.isSymbolicLink() || !before.isFile() || before.size < minimumBytes || before.size > maximumBytes) {
    throw new Error("Runtime output is not a bounded regular file")
  }
  const handle = await fs.open(filePath, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0))
  try {
    const opened = await handle.stat()
    if (!sameIdentity(snapshot(before), snapshot(opened))) throw new Error("Runtime output changed during validation")
    if (readBytes === undefined) return await handle.readFile()
    const output = Buffer.alloc(Math.min(readBytes, opened.size))
    const { bytesRead } = await handle.read(output, 0, output.length, 0)
    return output.subarray(0, bytesRead)
  } finally {
    await handle.close()
  }
}

function assertMediaPreserved(source: SubtitleMediaInspection, output: SubtitleMediaInspection) {
  const tolerance = Math.max(1_000, Math.round(source.durationMs * 0.01))
  if (
    output.width !== source.width ||
    output.height !== source.height ||
    Math.abs(output.durationMs - source.durationMs) > tolerance ||
    output.audioStreams.length !== source.audioStreams.length
  ) {
    throw new Error("Processed video does not preserve source media")
  }
}

function safeStem(name: string) {
  const stem = path.basename(name, path.extname(name)).replace(/[^A-Za-z0-9._-]+/gu, "-").replace(/^[.-]+|[.-]+$/gu, "")
  return stem.slice(0, 120) || "video"
}

function safeMediaExtension(name: string) {
  const extension = path.extname(path.basename(name)).toLowerCase()
  return [".avi", ".flv", ".m4v", ".mkv", ".mov", ".mp4", ".webm"].includes(extension) ? extension : ".mkv"
}

function portableFileName(name: string) {
  if (!name || name.length > 255 || name !== path.basename(name) || /[\\/:\u0000-\u001f\u007f]/u.test(name) || /[. ]$/u.test(name)) {
    throw new Error("Output name is not portable")
  }
  return name
}

function safeSubtitleTitle(value: string) {
  const title = value.replace(/[\u0000-\u001f\u007f]/gu, " ").replace(/\s+/gu, " ").trim()
  return title.slice(0, 120) || "Subtitles"
}

const mp4Languages: Readonly<Record<string, string>> = {
  ar: "ara",
  de: "deu",
  en: "eng",
  es: "spa",
  fr: "fra",
  hi: "hin",
  id: "ind",
  it: "ita",
  ja: "jpn",
  ko: "kor",
  nl: "nld",
  pl: "pol",
  pt: "por",
  ru: "rus",
  th: "tha",
  tr: "tur",
  uk: "ukr",
  vi: "vie",
  zh: "zho",
}

function mp4SubtitleLanguage(language: string) {
  return mp4Languages[language.toLowerCase().split("-")[0]!] ?? "und"
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error
}

function throwIfAborted(signal: AbortSignal) {
  if (signal.aborted) throw signal.reason ?? new DOMException("Canceled", "AbortError")
}
