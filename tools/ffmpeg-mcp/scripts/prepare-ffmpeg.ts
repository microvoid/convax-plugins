import { createHash } from "node:crypto"
import { execFile } from "node:child_process"
import { chmod, mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { promisify } from "node:util"

import {
  ffmpegSource,
  hostTarget,
  macosDeploymentTarget,
  targetFor,
  type FfmpegTarget,
} from "./ffmpeg-targets.ts"

const execute = promisify(execFile)
const toolRoot = path.join(import.meta.dir, "..")
const vendorDirectory = path.join(toolRoot, "vendor")
const sourceDirectory = path.join(vendorDirectory, "source")
const buildRoot = path.join(vendorDirectory, "build")
const archivePath = path.join(sourceDirectory, `${ffmpegSource.directory}.tar.xz`)
const extractedSource = path.join(sourceDirectory, ffmpegSource.directory)
const maximumBuildOutputBytes = 16 * 1024 * 1024

const configureArguments = [
  "--disable-autodetect",
  "--disable-debug",
  "--disable-devices",
  "--disable-demuxer=concat",
  "--disable-demuxer=hls",
  "--disable-demuxer=webm_dash_manifest",
  "--disable-doc",
  "--disable-ffplay",
  "--disable-ffprobe",
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
  "--enable-neon",
  "--enable-zlib",
  `--extra-cflags=-mmacosx-version-min=${macosDeploymentTarget}`,
  `--extra-ldflags=-mmacosx-version-min=${macosDeploymentTarget}`,
  "--extra-version=convax-ffmpeg-tools",
] as const

export interface PreparedFfmpeg {
  binaryPath: string
  binarySha256: string
  target: FfmpegTarget
}

function sha256(bytes: Uint8Array) {
  return createHash("sha256").update(bytes).digest("hex")
}

function verifiedSource(bytes: Uint8Array) {
  return bytes.length === ffmpegSource.archiveSize && sha256(bytes) === ffmpegSource.archiveSha256
}

async function verifyRequiredPgp(sourceArchive: string) {
  if (Bun.env.CONVAX_FFMPEG_REQUIRE_PGP?.trim() !== "1") return
  const signaturePath = Bun.env.CONVAX_FFMPEG_SOURCE_SIGNATURE?.trim()
  const signerKeyPath = Bun.env.CONVAX_FFMPEG_SIGNING_KEY?.trim()
  if (!signaturePath || !signerKeyPath) {
    throw new Error("PGP verification requires pinned FFmpeg signature and signing-key files")
  }
  const [signature, signerKey] = await Promise.all([
    readFile(signaturePath),
    readFile(signerKeyPath),
  ])
  if (
    signature.length !== ffmpegSource.signatureSize
    || sha256(signature) !== ffmpegSource.signatureSha256
  ) {
    throw new Error("FFmpeg source signature failed size or SHA-256 verification")
  }
  if (
    signerKey.length !== ffmpegSource.signerKeySize
    || sha256(signerKey) !== ffmpegSource.signerKeySha256
  ) {
    throw new Error("FFmpeg signing key failed size or SHA-256 verification")
  }

  const gpg = Bun.which("gpg")
  if (!gpg) throw new Error("PGP verification is required but gpg is unavailable")
  const home = await mkdtemp(path.join(os.tmpdir(), "convax-ffmpeg-gpg-"))
  try {
    await chmod(home, 0o700)
    const common = ["--batch", "--no-options", "--homedir", home] as const
    await execute(gpg, [...common, "--import", signerKeyPath], {
      encoding: "utf8",
      maxBuffer: maximumBuildOutputBytes,
    })
    const { stdout } = await execute(gpg, [...common, "--with-colons", "--fingerprint"], {
      encoding: "utf8",
      maxBuffer: maximumBuildOutputBytes,
    })
    const fingerprints = stdout.split("\n")
      .filter((line) => line.startsWith("fpr:"))
      .map((line) => line.split(":")[9])
    if (!fingerprints.includes(ffmpegSource.signerFingerprint)) {
      throw new Error("Imported FFmpeg signing key has an unexpected fingerprint")
    }
    await execute(gpg, [...common, "--verify", signaturePath, sourceArchive], {
      encoding: "utf8",
      maxBuffer: maximumBuildOutputBytes,
    })
  } finally {
    await rm(home, { force: true, recursive: true })
  }
}

async function downloadSource() {
  const existing = await readFile(archivePath).catch(() => undefined)
  if (existing && verifiedSource(existing)) return archivePath

  const localSource = Bun.env.CONVAX_FFMPEG_SOURCE_ARCHIVE?.trim()
  let bytes: Uint8Array
  if (localSource) {
    bytes = await readFile(localSource)
  } else {
    const response = await fetch(ffmpegSource.archiveUrl, {
      redirect: "follow",
      signal: AbortSignal.timeout(180_000),
    })
    if (!response.ok || !response.url.startsWith("https://")) {
      throw new Error(`Unable to download pinned FFmpeg source archive (${response.status})`)
    }
    const declaredLength = Number(response.headers.get("content-length"))
    if (Number.isFinite(declaredLength) && declaredLength !== ffmpegSource.archiveSize) {
      throw new Error("Pinned FFmpeg source archive has an unexpected declared size")
    }
    bytes = new Uint8Array(await response.arrayBuffer())
  }
  if (!verifiedSource(bytes)) {
    throw new Error("Pinned FFmpeg source archive failed size or SHA-256 verification")
  }

  await mkdir(sourceDirectory, { mode: 0o700, recursive: true })
  const temporary = path.join(sourceDirectory, `ffmpeg-source-${process.pid}.tmp`)
  try {
    await writeFile(temporary, bytes, { flag: "wx", mode: 0o600 })
    await rename(temporary, archivePath)
  } finally {
    await rm(temporary, { force: true })
  }
  return archivePath
}

async function extractedArchive(sourceArchive: string) {
  const marker = path.join(extractedSource, "configure")
  if ((await stat(marker).catch(() => undefined))?.isFile()) return extractedSource

  const { stdout: listing } = await execute("/usr/bin/tar", ["-tf", sourceArchive], {
    encoding: "utf8",
    maxBuffer: maximumBuildOutputBytes,
  })
  const entries = listing.split("\n").filter(Boolean)
  const prefix = `${ffmpegSource.directory}/`
  if (
    entries.length === 0
    || entries.some((entry) =>
      entry.includes("\\")
      || entry.startsWith("/")
      || entry.split("/").includes("..")
      || entry !== ffmpegSource.directory && !entry.startsWith(prefix)
    )
  ) {
    throw new Error("Pinned FFmpeg source archive contains an unsafe path")
  }

  await rm(extractedSource, { force: true, recursive: true })
  await mkdir(sourceDirectory, { mode: 0o700, recursive: true })
  await run("/usr/bin/tar", ["-xf", sourceArchive, "-C", sourceDirectory])
  if (!(await stat(marker)).isFile()) throw new Error("Pinned FFmpeg source archive is missing configure")
  await chmod(marker, 0o700)
  return extractedSource
}

function buildIdentity(target: FfmpegTarget) {
  return `${JSON.stringify({
    builder: 1,
    configureArguments,
    macosDeploymentTarget,
    sourceSha256: ffmpegSource.archiveSha256,
    target,
  })}\n`
}

async function run(command: string, args: readonly string[], options: { cwd?: string } = {}) {
  await new Promise<void>((resolve, reject) => {
    const child = Bun.spawn([command, ...args], {
      ...(options.cwd ? { cwd: options.cwd } : {}),
      env: {
        HOME: process.env.HOME ?? os.homedir(),
        LANG: "C",
        LC_ALL: "C",
        MACOSX_DEPLOYMENT_TARGET: macosDeploymentTarget,
        PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
      },
      stderr: "inherit",
      stdout: "inherit",
    })
    void child.exited.then((code) => {
      if (code === 0) resolve()
      else reject(new Error(`${path.basename(command)} exited with status ${code}`))
    }, reject)
  })
}

async function buildFromSource(target: FfmpegTarget, source: string) {
  if (target.platform !== "darwin" || target.arch !== "arm64") {
    throw new Error("Only the native darwin-arm64 FFmpeg source build is reviewed")
  }
  if (os.platform() !== target.platform || os.arch() !== target.arch) {
    throw new Error("FFmpeg darwin-arm64 must be built and smoke-tested on a native darwin-arm64 runner")
  }

  const buildDirectory = path.join(buildRoot, `${target.platform}-${target.arch}`)
  const binaryPath = path.join(buildDirectory, "ffmpeg")
  const stampPath = path.join(buildDirectory, ".convax-build.json")
  const identity = buildIdentity(target)
  const currentStamp = await readFile(stampPath, "utf8").catch(() => undefined)
  if (currentStamp === identity && (await stat(binaryPath).catch(() => undefined))?.isFile()) {
    return binaryPath
  }

  await rm(buildDirectory, { force: true, recursive: true })
  await mkdir(buildDirectory, { mode: 0o700, recursive: true })
  await run(path.join(source, "configure"), [
    `--prefix=${path.join(buildDirectory, "install")}`,
    "--arch=arm64",
    "--target-os=darwin",
    "--cc=clang",
    ...configureArguments,
  ], { cwd: buildDirectory })
  await mkdir(path.join(buildDirectory, "fftools", "resources"), { recursive: true })
  await run("/usr/bin/make", [`-j${Math.max(1, os.availableParallelism())}`, "ffmpeg"], {
    cwd: buildDirectory,
  })
  if (!(await stat(binaryPath)).isFile()) throw new Error("FFmpeg source build did not produce the ffmpeg executable")
  await chmod(binaryPath, 0o700)
  await writeFile(stampPath, identity, { mode: 0o600 })
  return binaryPath
}

export async function prepareFfmpeg(target: FfmpegTarget): Promise<PreparedFfmpeg> {
  const sourceArchive = await downloadSource()
  await verifyRequiredPgp(sourceArchive)
  const source = await extractedArchive(sourceArchive)
  const binaryPath = await buildFromSource(target, source)
  const binary = await readFile(binaryPath)
  if (binary.length === 0 || binary.length > 128 * 1024 * 1024) {
    throw new Error("Built FFmpeg executable has an invalid size")
  }
  const binarySha256 = sha256(binary)
  return { binaryPath, binarySha256, target }
}

function selectedTarget(argv: readonly string[]) {
  if (argv.length === 1 && argv[0] === "--host") return hostTarget()
  if (argv.length === 2) return targetFor(argv[0]!, argv[1]!)
  throw new Error("Usage: prepare-ffmpeg.ts --host | darwin arm64")
}

if (import.meta.main) {
  const target = selectedTarget(process.argv.slice(2))
  const prepared = await prepareFfmpeg(target)
  console.log(`Prepared source-built FFmpeg ${ffmpegSource.version} ${target.platform}-${target.arch} (${prepared.binarySha256}).`)
}
