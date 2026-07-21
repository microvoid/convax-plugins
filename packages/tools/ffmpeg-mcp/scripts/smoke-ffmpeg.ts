import { execFile } from "node:child_process"
import { readFile } from "node:fs/promises"
import { promisify } from "node:util"

import { ffmpegSource, hostTarget, macosDeploymentTarget } from "./ffmpeg-targets.ts"
import { prepareFfmpeg } from "./prepare-ffmpeg.ts"

const execute = promisify(execFile)
const target = hostTarget()
const prepared = await prepareFfmpeg(target)
const { stdout, stderr } = await execute(prepared.binaryPath, ["-L"], {
  encoding: "utf8",
  env: { LANG: "C", LC_ALL: "C" },
  maxBuffer: 4 * 1024 * 1024,
})
const licenseOutput = `${stdout}\n${stderr}`
const normalizedConfiguration = licenseOutput.replaceAll("'", "").replaceAll('"', "")
if (!new RegExp(`ffmpeg version ${ffmpegSource.version.replaceAll(".", "\\.")}`, "u").test(licenseOutput)) {
  throw new Error(`Source-built FFmpeg did not report version ${ffmpegSource.version}`)
}
for (const forbiddenFlag of ["--enable-gpl", "--enable-version3", "--enable-nonfree"]) {
  if (licenseOutput.includes(forbiddenFlag)) {
    throw new Error(`Source-built FFmpeg smoke check detected forbidden configure flag ${forbiddenFlag}`)
  }
}
for (const requiredFlag of [
  "--disable-autodetect",
  "--disable-devices",
  "--disable-demuxer=concat",
  "--disable-demuxer=hls",
  "--disable-demuxer=webm_dash_manifest",
  "--disable-muxer=dash",
  "--disable-muxer=hds",
  "--disable-muxer=hls",
  "--disable-muxer=segment",
  "--disable-muxer=smoothstreaming",
  "--disable-muxer=stream_segment",
  "--disable-muxer=tee",
  "--disable-muxer=webm_chunk",
  "--disable-muxer=webm_dash_manifest",
  "--disable-network",
  "--disable-shared",
  "--enable-static",
  "--enable-pic",
  "--enable-pthreads",
  "--enable-videotoolbox",
  "--enable-audiotoolbox",
  "--enable-zlib",
  `--extra-cflags=-mmacosx-version-min=${macosDeploymentTarget}`,
  `--extra-ldflags=-mmacosx-version-min=${macosDeploymentTarget}`,
]) {
  if (!normalizedConfiguration.includes(requiredFlag)) {
    throw new Error(`Source-built FFmpeg is missing reviewed configure flag ${requiredFlag}`)
  }
}

const { stdout: linkedLibraries } = await execute("/usr/bin/otool", ["-L", prepared.binaryPath], {
  encoding: "utf8",
  maxBuffer: 4 * 1024 * 1024,
})
const dependencies = linkedLibraries.split("\n").slice(1).map((line) => line.trim()).filter(Boolean)
if (
  dependencies.length === 0
  || dependencies.some((line) => !line.startsWith("/System/Library/") && !line.startsWith("/usr/lib/"))
) {
  throw new Error("Source-built FFmpeg links a non-system dynamic library")
}
const { stdout: loadCommands } = await execute("/usr/bin/otool", ["-l", prepared.binaryPath], {
  encoding: "utf8",
  maxBuffer: 4 * 1024 * 1024,
})
if (!new RegExp(`\\bminos\\s+${macosDeploymentTarget.replace(".", "\\.")}\\b`, "u").test(loadCommands)) {
  throw new Error(`Source-built FFmpeg does not target macOS ${macosDeploymentTarget}`)
}
const binary = await readFile(prepared.binaryPath)
for (const forbiddenFlag of ["--enable-gpl", "--enable-version3", "--enable-nonfree"]) {
  if (binary.includes(Buffer.from(forbiddenFlag, "utf8"))) {
    throw new Error(`Source-built FFmpeg executable embeds ${forbiddenFlag}`)
  }
}
const { stdout: encoders } = await execute(prepared.binaryPath, ["-hide_banner", "-encoders"], {
  encoding: "utf8",
  env: { LANG: "C", LC_ALL: "C" },
  maxBuffer: 8 * 1024 * 1024,
})
for (const encoder of ["h264_videotoolbox", "aac", "png"]) {
  if (!new RegExp(`\\b${encoder}\\b`, "u").test(encoders)) {
    throw new Error(`Source-built FFmpeg is missing required encoder ${encoder}`)
  }
}
function formatNames(output: string) {
  return new Set(output.split("\n").flatMap((line) => {
    const fields = line.trim().split(/\s+/u)
    return /^[D.E]{1,3}$/u.test(fields[0] ?? "") && fields[1] ? fields[1].split(",") : []
  }))
}
const [{ stdout: demuxerOutput }, { stdout: muxerOutput }] = await Promise.all([
  execute(prepared.binaryPath, ["-hide_banner", "-demuxers"], {
    encoding: "utf8",
    env: { LANG: "C", LC_ALL: "C" },
    maxBuffer: 8 * 1024 * 1024,
  }),
  execute(prepared.binaryPath, ["-hide_banner", "-muxers"], {
    encoding: "utf8",
    env: { LANG: "C", LC_ALL: "C" },
    maxBuffer: 8 * 1024 * 1024,
  }),
])
const demuxers = formatNames(demuxerOutput)
for (const demuxer of ["concat", "hls", "webm_dash_manifest"]) {
  if (demuxers.has(demuxer)) throw new Error(`Source-built FFmpeg still exposes forbidden demuxer ${demuxer}`)
}
const muxers = formatNames(muxerOutput)
for (const muxer of [
  "dash", "hds", "hls", "segment", "smoothstreaming", "stream_segment", "ssegment", "tee",
  "webm_chunk", "webm_dash_manifest",
]) {
  if (muxers.has(muxer)) throw new Error(`Source-built FFmpeg still exposes forbidden muxer ${muxer}`)
}
console.log(`Verified source-built FFmpeg ${ffmpegSource.version} ${target.platform}-${target.arch} license and system linkage.`)
