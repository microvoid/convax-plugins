import { spawn, type ChildProcess } from "node:child_process"
import { lstat, open, readdir } from "node:fs/promises"
import path from "node:path"

import { resolveFfmpegArguments } from "./argument-policy.ts"
import {
  type GenerationArtifact,
  type GenerationCall,
  FfmpegInputError,
  mimeTypeForOutput,
} from "./contracts.ts"

export interface FfmpegExecutableLease {
  path: string
  dispose(): Promise<void>
}

export type FfmpegExecutableResolver = () => Promise<FfmpegExecutableLease>

const maximumArtifactBytes = 2 * 1024 * 1024 * 1024
const maximumDiagnosticBytes = 64 * 1024
const terminationGracePeriodMs = 750
const outputMonitorIntervalMs = 25

export class FfmpegExecutionError extends Error {
  constructor() {
    super("FFmpeg transform failed.")
    this.name = "FfmpegExecutionError"
  }
}

function abortError() {
  return new DOMException("FFmpeg transform was cancelled", "AbortError")
}

function normalizedMimeType(value: string) {
  return value.split(";", 1)[0]!.trim().toLowerCase()
}

function sniffMimeType(header: Buffer) {
  if (header.length >= 8 && header.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return "image/png"
  }
  if (header.length >= 3 && header[0] === 0xff && header[1] === 0xd8 && header[2] === 0xff) return "image/jpeg"
  if (header.subarray(0, 6).toString("ascii") === "GIF87a" || header.subarray(0, 6).toString("ascii") === "GIF89a") {
    return "image/gif"
  }
  if (header.subarray(0, 4).toString("ascii") === "RIFF" && header.subarray(8, 12).toString("ascii") === "WEBP") {
    return "image/webp"
  }
  if (header.subarray(0, 4).toString("hex") === "1a45dfa3") return "video/webm"
  if (header.length >= 12 && header.subarray(4, 8).toString("ascii") === "ftyp") {
    const brand = header.subarray(8, 12).toString("ascii")
    if (brand === "M4A " || brand === "M4B ") return "audio/mp4"
    return brand === "qt  " ? "video/quicktime" : "video/mp4"
  }
  if (header.subarray(0, 4).toString("ascii") === "OggS") return "audio/ogg"
  if (header.subarray(0, 4).toString("ascii") === "fLaC") return "audio/flac"
  if (header.subarray(0, 4).toString("ascii") === "RIFF" && header.subarray(8, 12).toString("ascii") === "WAVE") {
    return "audio/wav"
  }
  if (header.subarray(0, 3).toString("ascii") === "ID3" ||
      header.length >= 2 && header[0] === 0xff && (header[1]! & 0xe0) === 0xe0) {
    return "audio/mpeg"
  }
  return undefined
}

async function validateReference(reference: GenerationCall["references"][number]) {
  const metadata = await lstat(reference.path).catch(() => undefined)
  if (!metadata?.isFile() || metadata.isSymbolicLink() || metadata.size <= 0) {
    throw new FfmpegInputError("Every FFmpeg input must be a regular staged media file.")
  }
  const handle = await open(reference.path, "r")
  try {
    const header = Buffer.alloc(64)
    const { bytesRead } = await handle.read(header, 0, header.length, 0)
    const actual = sniffMimeType(header.subarray(0, bytesRead))
    const claimed = normalizedMimeType(reference.mime_type)
    const wavPair = new Set([actual, claimed])
    if (!actual || actual !== claimed && !(wavPair.has("audio/wav") && wavPair.has("audio/x-wav"))) {
      throw new FfmpegInputError("Every FFmpeg input must match a supported host media signature.")
    }
  } finally {
    await handle.close()
  }
}

async function inspectOutputDirectory(outputDirectory: string, outputName: string) {
  const directory = await lstat(outputDirectory).catch(() => undefined)
  if (!directory?.isDirectory() || directory.isSymbolicLink()) throw new FfmpegExecutionError()
  const entries = await readdir(outputDirectory)
  if (entries.length > 1 || entries.some((entry) => entry !== outputName)) throw new FfmpegExecutionError()
  if (entries.length === 0) return
  const output = await lstat(path.join(outputDirectory, outputName)).catch(() => undefined)
  if (!output?.isFile() || output.isSymbolicLink() || output.size >= maximumArtifactBytes) {
    throw new FfmpegExecutionError()
  }
}

async function requireEmptyOutputDirectory(outputDirectory: string) {
  const directory = await lstat(outputDirectory).catch(() => undefined)
  if (!directory?.isDirectory() || directory.isSymbolicLink() || (await readdir(outputDirectory)).length !== 0) {
    throw new FfmpegInputError("FFmpeg output_directory must be a new empty host directory.")
  }
}

async function runProcess(
  executable: string,
  argv: readonly string[],
  cwd: string,
  outputName: string,
  signal: AbortSignal,
) {
  if (signal.aborted) throw abortError()
  const outputPath = argv.at(-1)
  if (!outputPath) throw new FfmpegExecutionError()
  const child = spawn(executable, [
    "-nostdin",
    "-hide_banner",
    "-y",
    "-protocol_whitelist",
    "file",
    ...argv.slice(0, -1),
    "-fs",
    String(maximumArtifactBytes),
    outputPath,
  ], {
    cwd,
    env: { LANG: "C", LC_ALL: "C" },
    shell: false,
    stdio: ["ignore", "ignore", "pipe"],
    windowsHide: true,
  })
  let diagnosticBytes = 0
  child.stderr?.on("data", (chunk: Buffer) => {
    diagnosticBytes = Math.min(maximumDiagnosticBytes, diagnosticBytes + chunk.length)
  })

  let forceTimer: ReturnType<typeof setTimeout> | undefined
  const terminate = () => {
    if (child.exitCode !== null || child.signalCode !== null) return
    child.kill("SIGTERM")
    forceTimer = setTimeout(() => child.kill("SIGKILL"), terminationGracePeriodMs)
    forceTimer.unref?.()
  }
  signal.addEventListener("abort", terminate, { once: true })
  let monitorFailure: unknown
  let monitorTail = Promise.resolve()
  const monitor = () => {
    monitorTail = monitorTail.then(() => inspectOutputDirectory(cwd, outputName)).catch((error) => {
      monitorFailure ??= error
      terminate()
    })
  }
  const monitorTimer = setInterval(monitor, outputMonitorIntervalMs)
  monitorTimer.unref?.()
  try {
    const result = await processExit(child)
    clearInterval(monitorTimer)
    await monitorTail
    if (!monitorFailure) {
      try {
        await inspectOutputDirectory(cwd, outputName)
      } catch (error) {
        monitorFailure = error
      }
    }
    if (monitorFailure) throw new FfmpegExecutionError()
    if (signal.aborted) throw abortError()
    if (result.code !== 0) throw new FfmpegExecutionError()
  } finally {
    clearInterval(monitorTimer)
    signal.removeEventListener("abort", terminate)
    if (forceTimer) clearTimeout(forceTimer)
  }
}

function processExit(child: ChildProcess) {
  return new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    child.once("error", reject)
    child.once("exit", (code, signal) => resolve({ code, signal }))
  })
}

export class FfmpegEngine {
  constructor(private readonly resolveExecutable: FfmpegExecutableResolver) {}

  async generate(call: GenerationCall, signal: AbortSignal): Promise<GenerationArtifact[]> {
    const outputPath = path.join(call.output_directory, call.output_name)
    await Promise.all(call.references.map(validateReference))
    await requireEmptyOutputDirectory(call.output_directory)
    const resolved = resolveFfmpegArguments(
      call.arguments_json,
      call.references,
      outputPath,
    )
    const lease = await this.resolveExecutable()
    try {
      await runProcess(lease.path, resolved.argv, call.output_directory, call.output_name, signal)
      const output = await lstat(outputPath)
      if (!output.isFile() || output.isSymbolicLink() || output.size <= 0 || output.size >= maximumArtifactBytes) {
        throw new FfmpegExecutionError()
      }
      return [{
        mimeType: mimeTypeForOutput(call.output_name, call.output),
        name: call.output_name,
        path: call.output_name,
      }]
    } catch (error) {
      if (signal.aborted || error instanceof DOMException && error.name === "AbortError") throw abortError()
      if (error instanceof FfmpegExecutionError) throw error
      throw new FfmpegExecutionError()
    } finally {
      await lease.dispose().catch(() => undefined)
    }
  }
}
