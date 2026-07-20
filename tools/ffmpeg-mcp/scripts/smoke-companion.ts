import { execFile, spawn, type ChildProcessWithoutNullStreams } from "node:child_process"
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { createInterface } from "node:readline"
import { promisify } from "node:util"

import { macosDeploymentTarget } from "./ffmpeg-targets.ts"

const toolRoot = path.join(import.meta.dir, "..")
const companion = path.resolve(toolRoot, process.argv[2] ?? "dist/convax-ffmpeg-mcp")
const relativeCompanion = path.relative(toolRoot, companion)
if (relativeCompanion === "" || relativeCompanion.startsWith("..") || path.isAbsolute(relativeCompanion)) {
  throw new Error("Companion smoke target must be a file inside the FFmpeg tool directory")
}

const directory = await mkdtemp(path.join(os.tmpdir(), "convax-ffmpeg-companion-smoke-"))
const outputDirectory = path.join(directory, "output")
const inputPath = path.join(directory, "input.png")
const audioInputPath = path.join(directory, "input.wav")
let child: ChildProcessWithoutNullStreams | undefined
const execute = promisify(execFile)

function timeout<T>(promise: Promise<T>, milliseconds: number, message: string) {
  let timer: ReturnType<typeof setTimeout> | undefined
  const expired = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(message)), milliseconds)
  })
  return Promise.race([promise, expired]).finally(() => {
    if (timer) clearTimeout(timer)
  })
}

async function assertPng(filePath: string, width: number, height: number) {
  const png = await readFile(filePath)
  if (
    png.length < 24
    || !png.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    || png.readUInt32BE(16) !== width
    || png.readUInt32BE(20) !== height
  ) {
    throw new Error(`Compiled companion did not create the expected ${width}-by-${height} PNG`)
  }
}

async function assertMp4(filePath: string) {
  const mp4 = await readFile(filePath)
  if (mp4.length < 32 || mp4.subarray(4, 8).toString("ascii") !== "ftyp") {
    throw new Error("Compiled companion did not create the expected MP4 artifact")
  }
}

async function assertWav(filePath: string) {
  const wav = await readFile(filePath)
  if (
    wav.length <= 44
    || wav.subarray(0, 4).toString("ascii") !== "RIFF"
    || wav.subarray(8, 12).toString("ascii") !== "WAVE"
  ) {
    throw new Error("Compiled companion did not create the expected WAV artifact")
  }
}

function pcmWavFixture() {
  const sampleRate = 8_000
  const sampleCount = 800
  const bytesPerSample = 2
  const dataBytes = sampleCount * bytesPerSample
  const wav = Buffer.alloc(44 + dataBytes)
  wav.write("RIFF", 0, "ascii")
  wav.writeUInt32LE(36 + dataBytes, 4)
  wav.write("WAVE", 8, "ascii")
  wav.write("fmt ", 12, "ascii")
  wav.writeUInt32LE(16, 16)
  wav.writeUInt16LE(1, 20)
  wav.writeUInt16LE(1, 22)
  wav.writeUInt32LE(sampleRate, 24)
  wav.writeUInt32LE(sampleRate * bytesPerSample, 28)
  wav.writeUInt16LE(bytesPerSample, 32)
  wav.writeUInt16LE(16, 34)
  wav.write("data", 36, "ascii")
  wav.writeUInt32LE(dataBytes, 40)
  for (let index = 0; index < sampleCount; index += 1) {
    const sample = Math.round(Math.sin(2 * Math.PI * 440 * index / sampleRate) * 8_192)
    wav.writeInt16LE(sample, 44 + index * bytesPerSample)
  }
  return wav
}

try {
  await mkdir(outputDirectory)
  await writeFile(
    inputPath,
    Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
      "base64",
    ),
  )
  await writeFile(audioInputPath, pcmWavFixture())
  const companionMetadata = await stat(companion)
  if (!companionMetadata.isFile() || companionMetadata.size <= 0 || companionMetadata.size >= 128 * 1024 * 1024) {
    throw new Error("Compiled native companion must be one regular executable smaller than 128 MiB")
  }
  const companionBytes = await readFile(companion)
  if (!companionBytes.subarray(0, 4).equals(Buffer.from([0xcf, 0xfa, 0xed, 0xfe]))) {
    throw new Error("Compiled companion is not a native 64-bit Mach-O executable")
  }
  const [{ stdout: loadCommands }, { stdout: linkedLibraries }] = await Promise.all([
    execute("/usr/bin/otool", ["-l", companion], { encoding: "utf8", maxBuffer: 8 * 1024 * 1024 }),
    execute("/usr/bin/otool", ["-L", companion], { encoding: "utf8", maxBuffer: 8 * 1024 * 1024 }),
  ])
  if (!loadCommands.includes("sectname __ffmpeg") ||
      !new RegExp(`\\bminos\\s+${macosDeploymentTarget.replace(".", "\\.")}\\b`, "u").test(loadCommands)) {
    throw new Error(`Compiled companion must embed FFmpeg and target macOS ${macosDeploymentTarget}`)
  }
  if (/JavaScriptCore|WebKit|\blibbun\b/iu.test(linkedLibraries)) {
    throw new Error("Compiled companion unexpectedly links a JavaScript runtime")
  }
  const runningChild = spawn(companion, [], {
    cwd: toolRoot,
    shell: false,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  })
  child = runningChild
  runningChild.stderr.resume()
  const childExit = new Promise<number | null>((resolve, reject) => {
    runningChild.once("error", reject)
    runningChild.once("exit", (code) => resolve(code))
  })
  const lines = createInterface({ input: runningChild.stdout })
  const pending = new Map<number, (value: Record<string, unknown>) => void>()
  lines.on("line", (line) => {
    const value = JSON.parse(line) as Record<string, unknown>
    if (typeof value.id === "number") pending.get(value.id)?.(value)
  })
  function request(id: number, method: string, params: unknown) {
    const response = new Promise<Record<string, unknown>>((resolve) => pending.set(id, resolve))
    runningChild.stdin.write(`${JSON.stringify({ id, jsonrpc: "2.0", method, params })}\n`)
    return timeout(response, 60_000, `Companion ${method} smoke request timed out`).finally(() => pending.delete(id))
  }
  async function generate(options: {
    arguments: string[]
    id: number
    input: { mimeType: string; path: string; role: "audio" | "reference_image" | "reference_video" }
    name: string
    output: "audio" | "image" | "video"
    tool: "run.audio" | "run.image" | "run.video"
  }) {
    const operationOutputDirectory = path.join(outputDirectory, `operation-${options.id}`)
    await mkdir(operationOutputDirectory)
    const generated = await request(options.id, "tools/call", {
      arguments: {
        arguments_json: JSON.stringify(options.arguments),
        operation_id: `native-companion-smoke-${options.id}`,
        output: options.output,
        output_directory: operationOutputDirectory,
        output_name: options.name,
        prompt: "Exercise the compiled FFmpeg companion through its MCP artifact flow",
        references: [{
          kind: "file",
          mime_type: options.input.mimeType,
          name: path.basename(options.input.path),
          node_id: `smoke-input-${options.id}`,
          path: options.input.path,
          role: options.input.role,
        }],
        schema: "convax.generation-call/1",
      },
      name: options.tool,
    })
    const result = generated.result as {
      isError?: boolean
      structuredContent?: { artifacts?: Array<{ path?: string }>; schema?: string }
    } | undefined
    if (
      result?.isError
      || result?.structuredContent?.schema !== "convax.generation-result/1"
      || result.structuredContent.artifacts?.length !== 1
      || result.structuredContent.artifacts[0]?.path !== options.name
    ) {
      throw new Error(`Compiled companion did not return the expected ${options.name} generation result`)
    }
    return path.join(operationOutputDirectory, options.name)
  }

  const initialized = await request(1, "initialize", { protocolVersion: "2025-03-26" })
  if ((initialized.result as { serverInfo?: { name?: string } } | undefined)?.serverInfo?.name !== "convax-ffmpeg-mcp") {
    throw new Error("Compiled companion did not complete MCP initialization")
  }

  const scaled = await generate({
    arguments: ["-i", "{{input:0}}", "-vf", "scale=2:2", "-frames:v", "1", "{{output}}"],
    id: 2,
    input: { mimeType: "image/png", path: inputPath, role: "reference_image" },
    name: "scaled.png",
    output: "image",
    tool: "run.image",
  })
  await assertPng(scaled, 2, 2)

  const processedAudio = await generate({
    arguments: ["-i", "{{input:0}}", "-af", "volume=0.5", "-c:a", "pcm_s16le", "{{output}}"],
    id: 3,
    input: { mimeType: "audio/wav", path: audioInputPath, role: "audio" },
    name: "processed.wav",
    output: "audio",
    tool: "run.audio",
  })
  await assertWav(processedAudio)

  const sourceVideo = await generate({
    arguments: [
      "-loop", "1", "-i", "{{input:0}}", "-t", "2", "-vf", "scale=64:64,format=yuv420p",
      "-c:v", "h264_videotoolbox", "-allow_sw", "1", "-an", "{{output}}",
    ],
    id: 4,
    input: { mimeType: "image/png", path: scaled, role: "reference_image" },
    name: "source.mp4",
    output: "video",
    tool: "run.video",
  })
  await assertMp4(sourceVideo)

  const trimmed = await generate({
    arguments: [
      "-ss", "0.25", "-i", "{{input:0}}", "-t", "0.5", "-c:v", "h264_videotoolbox",
      "-allow_sw", "1", "-an",
      "{{output}}",
    ],
    id: 5,
    input: { mimeType: "video/mp4", path: sourceVideo, role: "reference_video" },
    name: "trimmed.mp4",
    output: "video",
    tool: "run.video",
  })
  await assertMp4(trimmed)

  const cropped = await generate({
    arguments: [
      "-i", "{{input:0}}", "-vf", "crop=32:32:0:0", "-c:v", "h264_videotoolbox",
      "-allow_sw", "1", "-an", "{{output}}",
    ],
    id: 6,
    input: { mimeType: "video/mp4", path: trimmed, role: "reference_video" },
    name: "cropped.mp4",
    output: "video",
    tool: "run.video",
  })
  await assertMp4(cropped)

  const extractedFrame = await generate({
    arguments: ["-i", "{{input:0}}", "-frames:v", "1", "{{output}}"],
    id: 7,
    input: { mimeType: "video/mp4", path: cropped, role: "reference_video" },
    name: "cropped-frame.png",
    output: "image",
    tool: "run.image",
  })
  await assertPng(extractedFrame, 32, 32)

  runningChild.stdin.end()
  const exitCode = await timeout(childExit, 5_000, "Compiled companion did not exit after stdin closed")
  if (exitCode !== 0) {
    throw new Error(`Compiled companion exited with status ${exitCode}`)
  }
  lines.close()
  console.log("Verified all compiled companion MCP tools with image, audio, trim, crop, and frame-extraction artifact flows.")
} finally {
  child?.kill("SIGKILL")
  await rm(directory, { force: true, recursive: true })
}
