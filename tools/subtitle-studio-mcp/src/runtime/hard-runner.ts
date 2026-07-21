import { spawn } from "node:child_process"
import { constants as fsConstants } from "node:fs"
import fs from "node:fs/promises"
import path from "node:path"

import type { PixelSubtitleRegion } from "../domain"
import { assertRuntimeFileStable, type VerifiedRuntimeFile } from "./inventory"

export const hardSubtitleEraseProtocolVersion = 1 as const

export interface VerifiedHardSubtitleRuntime {
  detectorModel: VerifiedRuntimeFile
  executable: VerifiedRuntimeFile
  ffmpeg: VerifiedRuntimeFile
  inpaintingModel: VerifiedRuntimeFile
  version: string
}

export interface HardSubtitleEraseSidecarRunInput {
  durationMs: number
  height: number
  outputRelativePath: string
  region: PixelSubtitleRegion
  report(progress: number, stage: string): void
  runtime: VerifiedHardSubtitleRuntime
  signal: AbortSignal
  sourcePath: string
  width: number
  workDirectory: string
}

export interface HardSubtitleEraseSidecarRunResult {
  outputPath: string
  outputRelativePath: string
}

export type HardSubtitleEraseSidecarRunner = (
  input: HardSubtitleEraseSidecarRunInput,
) => Promise<HardSubtitleEraseSidecarRunResult>

export interface HardSubtitleEraseSidecarRunnerOptions {
  maximumEventBytes?: number
  maximumEvents?: number
  maximumStderrBytes?: number
  maximumStdoutBytes?: number
  terminationGraceMs?: number
  timeoutMs?: number
}

interface HardSubtitleEraseSidecarRequest {
  input: { durationMs: number; height: number; path: string; width: number }
  models: { detectorPath: string; inpaintingPath: string }
  operation: "erase-hard-subtitles"
  output: { path: string }
  protocolVersion: typeof hardSubtitleEraseProtocolVersion
  region: PixelSubtitleRegion
}

const defaultMaximumEventBytes = 64 * 1024
const defaultMaximumEvents = 100_000
const defaultMaximumStderrBytes = 256 * 1024
const defaultMaximumStdoutBytes = 8 * 1024 * 1024
const defaultTerminationGraceMs = 3_000
const defaultTimeoutMs = 6 * 60 * 60 * 1_000

export function createHardSubtitleEraseSidecarRunner(
  options: HardSubtitleEraseSidecarRunnerOptions = {},
): HardSubtitleEraseSidecarRunner {
  const maximumEventBytes = boundedInteger(options.maximumEventBytes, defaultMaximumEventBytes, "event byte limit")
  const maximumEvents = boundedInteger(options.maximumEvents, defaultMaximumEvents, "event limit")
  const maximumStderrBytes = boundedInteger(options.maximumStderrBytes, defaultMaximumStderrBytes, "stderr limit")
  const maximumStdoutBytes = boundedInteger(options.maximumStdoutBytes, defaultMaximumStdoutBytes, "stdout limit")
  const terminationGraceMs = boundedInteger(
    options.terminationGraceMs,
    defaultTerminationGraceMs,
    "termination grace period",
  )
  const timeoutMs = boundedInteger(options.timeoutMs, defaultTimeoutMs, "timeout")

  return async (input) => {
    throwIfAborted(input.signal)
    validateRunInput(input)
    await Promise.all([
      assertRuntimeFileStable(input.runtime.executable),
      assertRuntimeFileStable(input.runtime.ffmpeg),
      assertRuntimeFileStable(input.runtime.detectorModel),
      assertRuntimeFileStable(input.runtime.inpaintingModel),
    ])
    if (path.dirname(input.runtime.executable.path) !== path.dirname(input.runtime.ffmpeg.path)) {
      throw new Error("Hard subtitle sidecar and FFmpeg are not one verified runtime")
    }
    const requestedOutput = portableRelativePath(input.outputRelativePath, "Hard subtitle output path")
    const request: HardSubtitleEraseSidecarRequest = {
      input: {
        durationMs: input.durationMs,
        height: input.height,
        path: input.sourcePath,
        width: input.width,
      },
      models: {
        detectorPath: input.runtime.detectorModel.path,
        inpaintingPath: input.runtime.inpaintingModel.path,
      },
      operation: "erase-hard-subtitles",
      output: { path: requestedOutput },
      protocolVersion: hardSubtitleEraseProtocolVersion,
      region: input.region,
    }
    const serializedRequest = `${JSON.stringify(request)}\n`
    if (Buffer.byteLength(serializedRequest, "utf8") > maximumEventBytes) {
      throw new Error("Hard subtitle request exceeds the protocol limit")
    }

    const outputRelativePath = await new Promise<string>((resolve, reject) => {
      const child = spawn(input.runtime.executable.path, [], {
        cwd: input.workDirectory,
        shell: false,
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      })
      const stderr: Buffer[] = []
      let stderrBytes = 0
      let stdoutBytes = 0
      let eventCount = 0
      let pending = Buffer.alloc(0)
      let resultPath: string | undefined
      let lastProgress = 0
      let settled = false
      let terminationError: unknown
      let terminationTimer: ReturnType<typeof setTimeout> | undefined

      const finish = (callback: () => void) => {
        if (settled) return
        settled = true
        input.signal.removeEventListener("abort", abort)
        clearTimeout(timeoutTimer)
        if (terminationTimer) clearTimeout(terminationTimer)
        callback()
      }
      const terminate = (error: unknown, graceful: boolean) => {
        if (settled || terminationError !== undefined) return
        terminationError = error
        child.kill(graceful ? "SIGTERM" : "SIGKILL")
        if (!graceful) return
        terminationTimer = setTimeout(() => {
          terminationTimer = undefined
          if (!settled) child.kill("SIGKILL")
        }, terminationGraceMs)
        terminationTimer.unref()
      }
      const abort = () => terminate(input.signal.reason ?? new DOMException("Canceled", "AbortError"), true)
      const parseEvent = (line: Buffer) => {
        if (terminationError !== undefined || settled || line.length === 0) return
        if (resultPath !== undefined) {
          terminate(new Error("Hard subtitle sidecar returned events after its result"), false)
          return
        }
        eventCount += 1
        if (eventCount > maximumEvents || line.length > maximumEventBytes) {
          terminate(new Error("Hard subtitle sidecar exceeded its event bounds"), false)
          return
        }
        let value: unknown
        try {
          value = JSON.parse(line.toString("utf8"))
        } catch {
          terminate(new Error("Hard subtitle sidecar returned invalid NDJSON"), false)
          return
        }
        if (!isRecord(value) || value.protocolVersion !== hardSubtitleEraseProtocolVersion) {
          terminate(new Error("Hard subtitle sidecar protocol version is incompatible"), false)
          return
        }
        if (value.type === "progress") {
          if (
            typeof value.progress !== "number" ||
            !Number.isFinite(value.progress) ||
            value.progress < lastProgress ||
            value.progress < 0 ||
            value.progress > 1 ||
            typeof value.stage !== "string" ||
            !value.stage.trim() ||
            value.stage.length > 160
          ) {
            terminate(new Error("Hard subtitle sidecar returned invalid progress"), false)
            return
          }
          lastProgress = value.progress
          input.report(value.progress, value.stage.trim())
          return
        }
        if (value.type === "result") {
          if (typeof value.outputPath !== "string") {
            terminate(new Error("Hard subtitle sidecar returned an invalid result"), false)
            return
          }
          try {
            resultPath = portableRelativePath(value.outputPath, "Hard subtitle result path")
          } catch (error) {
            terminate(error, false)
          }
          return
        }
        if (value.type === "error") {
          const message = typeof value.message === "string" ? value.message.trim().slice(0, 1_000) : ""
          terminate(new Error(message || "Hard subtitle sidecar reported an error"), false)
          return
        }
        terminate(new Error("Hard subtitle sidecar returned an unknown event"), false)
      }
      const consumeStdout = (chunk: Buffer) => {
        if (terminationError !== undefined || settled) return
        stdoutBytes += chunk.length
        if (stdoutBytes > maximumStdoutBytes) {
          terminate(new Error("Hard subtitle sidecar produced too much stdout"), false)
          return
        }
        pending = Buffer.concat([pending, chunk])
        while (true) {
          const newline = pending.indexOf(0x0a)
          if (newline < 0) break
          const line = pending.subarray(0, newline)
          pending = pending.subarray(newline + 1)
          parseEvent(line.length > 0 && line[line.length - 1] === 0x0d ? line.subarray(0, -1) : line)
          if (terminationError !== undefined) return
        }
        if (pending.length > maximumEventBytes) {
          terminate(new Error("Hard subtitle sidecar event exceeds the protocol limit"), false)
        }
      }
      const consumeStderr = (chunk: Buffer) => {
        if (terminationError !== undefined || settled) return
        stderrBytes += chunk.length
        if (stderrBytes > maximumStderrBytes) {
          terminate(new Error("Hard subtitle sidecar produced too much stderr"), false)
          return
        }
        stderr.push(chunk)
      }
      const timeoutTimer = setTimeout(
        () => terminate(new Error(`Hard subtitle sidecar timed out after ${timeoutMs} ms`), true),
        timeoutMs,
      )
      timeoutTimer.unref()

      input.signal.addEventListener("abort", abort, { once: true })
      if (input.signal.aborted) abort()
      child.stdout.on("data", consumeStdout)
      child.stderr.on("data", consumeStderr)
      child.stdin.once("error", (error) => terminate(error, false))
      child.once("error", (error) => finish(() => reject(terminationError ?? error)))
      child.once("close", (code, childSignal) => {
        if (!settled && terminationError === undefined && pending.length > 0) parseEvent(pending)
        finish(() => {
          if (terminationError !== undefined) {
            reject(terminationError)
            return
          }
          const stderrText = Buffer.concat(stderr).toString("utf8").trim().slice(-2_000)
          if (code !== 0) {
            reject(
              new Error(
                `Hard subtitle sidecar failed${code === null ? "" : ` with code ${code}`}${childSignal ? ` (${childSignal})` : ""}${stderrText ? `: ${stderrText}` : ""}`,
              ),
            )
            return
          }
          if (resultPath === undefined) {
            reject(new Error("Hard subtitle sidecar completed without a result"))
            return
          }
          if (resultPath !== requestedOutput) {
            reject(new Error("Hard subtitle sidecar returned an unexpected output path"))
            return
          }
          resolve(resultPath)
        })
      })
      if (terminationError === undefined) child.stdin.end(serializedRequest)
    })

    const outputPath = await validateHardSubtitleEraseOutput(input.workDirectory, outputRelativePath)
    return { outputPath, outputRelativePath }
  }
}

export const runHardSubtitleEraseSidecar = createHardSubtitleEraseSidecarRunner()

export async function validateHardSubtitleEraseOutput(workDirectory: string, relativePath: string): Promise<string> {
  const portable = portableRelativePath(relativePath, "Hard subtitle output path")
  if (path.extname(portable).toLowerCase() !== ".mp4") throw new Error("Hard subtitle output must be MP4")
  const directory = await fs.lstat(workDirectory)
  if (directory.isSymbolicLink() || !directory.isDirectory()) {
    throw new Error("Hard subtitle work directory is not a regular directory")
  }
  const realDirectory = await fs.realpath(workDirectory)
  const outputPath = path.join(workDirectory, ...portable.split("/"))
  const before = await fs.lstat(outputPath)
  if (before.isSymbolicLink() || !before.isFile() || before.size < 1) {
    throw new Error("Hard subtitle output is not a non-empty regular file")
  }
  const realOutput = await fs.realpath(outputPath)
  if (!isContainedPath(realDirectory, realOutput)) throw new Error("Hard subtitle output escaped its directory")
  const handle = await fs.open(realOutput, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0))
  try {
    const opened = await handle.stat()
    if (!opened.isFile() || opened.size < 1 || opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== before.size) {
      throw new Error("Hard subtitle output changed during validation")
    }
  } finally {
    await handle.close()
  }
  return realOutput
}

function validateRunInput(input: HardSubtitleEraseSidecarRunInput) {
  if (!path.isAbsolute(input.sourcePath) || !path.isAbsolute(input.workDirectory)) {
    throw new Error("Hard subtitle paths must be absolute")
  }
  if (!Number.isSafeInteger(input.durationMs) || input.durationMs < 0) throw new Error("Hard subtitle duration is invalid")
  if (!Number.isSafeInteger(input.width) || input.width < 1 || !Number.isSafeInteger(input.height) || input.height < 1) {
    throw new Error("Hard subtitle dimensions are invalid")
  }
  const values = [input.region.x, input.region.y, input.region.width, input.region.height]
  if (values.some((value) => !Number.isSafeInteger(value) || value < 0) || input.region.width < 1 || input.region.height < 1) {
    throw new Error("Hard subtitle region is invalid")
  }
  if (input.region.x + input.region.width > input.width || input.region.y + input.region.height > input.height) {
    throw new Error("Hard subtitle region must stay inside the video frame")
  }
}

function portableRelativePath(value: string, label: string) {
  if (!value || value.length > 512 || path.posix.isAbsolute(value) || path.win32.isAbsolute(value) || value.includes("\0")) {
    throw new Error(`${label} must be a relative path`)
  }
  const segments = value.split(/[\\/]/u)
  if (
    segments.some(
      (segment) =>
        !segment ||
        segment === "." ||
        segment === ".." ||
        segment.includes(":") ||
        /[\u0000-\u001f\u007f]/u.test(segment) ||
        /[. ]$/u.test(segment) ||
        /^(?:aux|com[1-9]|con|lpt[1-9]|nul|prn)(?:\.|$)/iu.test(segment),
    )
  ) {
    throw new Error(`${label} must stay inside the work directory`)
  }
  return segments.join("/")
}

function isContainedPath(parent: string, child: string) {
  const relative = path.relative(parent, child)
  return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
}

function boundedInteger(value: number | undefined, fallback: number, label: string) {
  const resolved = value ?? fallback
  if (!Number.isSafeInteger(resolved) || resolved < 1) throw new Error(`Hard subtitle ${label} must be positive`)
  return resolved
}

function throwIfAborted(signal: AbortSignal) {
  if (signal.aborted) throw signal.reason ?? new DOMException("Canceled", "AbortError")
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
}
