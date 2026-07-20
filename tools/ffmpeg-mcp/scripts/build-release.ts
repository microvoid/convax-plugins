import { execFile } from "node:child_process"
import { chmod, mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { promisify } from "node:util"

import { hostTarget, targetFor } from "./ffmpeg-targets.ts"
import { prepareFfmpeg } from "./prepare-ffmpeg.ts"

const toolRoot = path.join(import.meta.dir, "..")
const nativeRoot = path.join(toolRoot, "native")
const execute = promisify(execFile)
const maximumExecutableBytes = 128 * 1024 * 1024

function selectedTarget(argv: readonly string[]) {
  if (argv.length === 1 && argv[0] === "--host") return { target: hostTarget(), host: true }
  if (argv.length === 2) return { target: targetFor(argv[0]!, argv[1]!), host: false }
  throw new Error("Usage: build-release.ts --host | darwin arm64")
}

const { host, target } = selectedTarget(process.argv.slice(2))
if (target.platform !== "darwin" || target.arch !== "arm64") {
  throw new Error("The native FFmpeg companion is reviewed only for darwin-arm64")
}
if (os.platform() !== "darwin" || os.arch() !== "arm64") {
  throw new Error("The darwin-arm64 FFmpeg companion must be built on native Apple Silicon")
}
const prepared = await prepareFfmpeg(target)
const outputDirectory = host
  ? path.join(toolRoot, "dist")
  : path.join(toolRoot, "dist", `${target.platform}-${target.arch}`)
await mkdir(outputDirectory, { recursive: true })
const outfile = path.join(outputDirectory, "convax-ffmpeg-mcp")
const buildDirectory = await mkdtemp(path.join(os.tmpdir(), "convax-ffmpeg-native-"))
const temporaryOutput = path.join(outputDirectory, `.convax-ffmpeg-mcp-${process.pid}.tmp`)
try {
  const [{ stdout: clangOutput }, { stdout: swiftOutput }, { stdout: sdkOutput }] = await Promise.all([
    execute("/usr/bin/xcrun", ["--find", "clang"], { encoding: "utf8" }),
    execute("/usr/bin/xcrun", ["--find", "swiftc"], { encoding: "utf8" }),
    execute("/usr/bin/xcrun", ["--show-sdk-path"], { encoding: "utf8" }),
  ])
  const clang = clangOutput.trim()
  const swiftc = swiftOutput.trim()
  const sdk = sdkOutput.trim()
  if (!clang || !swiftc || !sdk) throw new Error("Unable to locate the native Apple compiler toolchain")

  const bridgeObject = path.join(buildDirectory, "EmbeddedSection.o")
  const hashFile = path.join(buildDirectory, "ffmpeg.sha256")
  await writeFile(hashFile, prepared.binarySha256, { encoding: "ascii", flag: "wx", mode: 0o600 })
  await execute(clang, [
    "-arch", "arm64",
    "-mmacosx-version-min=13.0",
    "-isysroot", sdk,
    "-I", nativeRoot,
    "-c", path.join(nativeRoot, "EmbeddedSection.c"),
    "-o", bridgeObject,
  ], { maxBuffer: 16 * 1024 * 1024 })

  const swiftSources = [
    "Models.swift",
    "SecurityPolicy.swift",
    "EmbeddedFFmpeg.swift",
    "FFmpegExecutor.swift",
    "MCPServer.swift",
    "main.swift",
  ].map((name) => path.join(nativeRoot, name))
  await rm(temporaryOutput, { force: true })
  await execute(swiftc, [
    "-target", "arm64-apple-macos13.0",
    "-sdk", sdk,
    "-O",
    "-whole-module-optimization",
    "-import-objc-header", path.join(nativeRoot, "Bridge.h"),
    ...swiftSources,
    bridgeObject,
    "-o", temporaryOutput,
    "-Xlinker", "-dead_strip",
    "-Xlinker", "-sectcreate",
    "-Xlinker", "__DATA",
    "-Xlinker", "__ffmpeg",
    "-Xlinker", prepared.binaryPath,
    "-Xlinker", "-sectcreate",
    "-Xlinker", "__DATA",
    "-Xlinker", "__ffhash",
    "-Xlinker", hashFile,
  ], { maxBuffer: 32 * 1024 * 1024 })

  const built = await stat(temporaryOutput)
  if (!built.isFile() || built.size <= 0 || built.size >= maximumExecutableBytes) {
    throw new Error("Native FFmpeg companion exceeds the 128 MiB executable boundary")
  }
  const [{ stdout: fileOutput }, { stdout: loadCommands }] = await Promise.all([
    execute("/usr/bin/file", [temporaryOutput], { encoding: "utf8" }),
    execute("/usr/bin/otool", ["-l", temporaryOutput], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 }),
  ])
  if (!fileOutput.includes("Mach-O 64-bit executable arm64")) {
    throw new Error("Native FFmpeg companion is not an arm64 Mach-O executable")
  }
  const buildVersion = loadCommands.match(/cmd LC_BUILD_VERSION[\s\S]*?\n\s*minos ([0-9.]+)/)
  if (buildVersion?.[1] !== "13.0") {
    throw new Error(`Native FFmpeg companion deployment target is ${buildVersion?.[1] ?? "unknown"}, expected 13.0`)
  }
  const bytes = await readFile(temporaryOutput)
  if (bytes.length !== built.size) throw new Error("Native FFmpeg companion changed during verification")
  await chmod(temporaryOutput, 0o755)
  await rename(temporaryOutput, outfile)
} finally {
  await rm(temporaryOutput, { force: true })
  await rm(buildDirectory, { force: true, recursive: true })
}
console.log(`Built ${outfile}`)
