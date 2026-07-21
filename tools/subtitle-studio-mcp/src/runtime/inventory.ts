import { createHash } from "node:crypto"
import { constants as fsConstants } from "node:fs"
import fs from "node:fs/promises"
import path from "node:path"

import type { SubtitleModelSize } from "../contracts"

export interface RuntimeFileDescriptor {
  byteSize: number
  relativePath: string
  sha256: string
}

export interface SubtitleRuntimeInventoryDescriptor {
  ffmpeg: RuntimeFileDescriptor
  ffprobe: RuntimeFileDescriptor
  hardErase?: {
    detectorModel: RuntimeFileDescriptor
    executable: RuntimeFileDescriptor
    inpaintingModel: RuntimeFileDescriptor
  }
  models: Partial<Record<SubtitleModelSize, RuntimeFileDescriptor>>
  rootDirectory: string
  version: string
  whisper: RuntimeFileDescriptor
}

export interface VerifiedRuntimeFile {
  readonly byteSize: number
  readonly executable: boolean
  readonly path: string
  readonly relativePath: string
  readonly sha256: string
  readonly snapshot: {
    readonly ctimeMs: number | bigint
    readonly dev: number | bigint
    readonly ino: number | bigint
    readonly mtimeMs: number | bigint
    readonly size: number | bigint
  }
}

export interface VerifiedSubtitleRuntimeInventory {
  readonly ffmpeg: VerifiedRuntimeFile
  readonly ffprobe: VerifiedRuntimeFile
  readonly hardErase?: {
    readonly detectorModel: VerifiedRuntimeFile
    readonly executable: VerifiedRuntimeFile
    readonly inpaintingModel: VerifiedRuntimeFile
  }
  readonly models: Readonly<Partial<Record<SubtitleModelSize, VerifiedRuntimeFile>>>
  readonly rootDirectory: string
  readonly version: string
  readonly whisper: VerifiedRuntimeFile
}

export type CompleteVerifiedSubtitleRuntimeInventory = VerifiedSubtitleRuntimeInventory & {
  readonly hardErase: NonNullable<VerifiedSubtitleRuntimeInventory["hardErase"]>
  readonly models: Readonly<Record<SubtitleModelSize, VerifiedRuntimeFile>>
}

const maximumRuntimeFileBytes = 2 * 1024 * 1024 * 1024

function portableRelativePath(value: unknown, label: string) {
  if (
    typeof value !== "string" ||
    !value ||
    value.length > 512 ||
    path.posix.isAbsolute(value) ||
    path.win32.isAbsolute(value) ||
    value.includes("\u0000")
  ) {
    throw new Error(`${label} must be a portable relative path`)
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
        /[. ]$/u.test(segment),
    )
  ) {
    throw new Error(`${label} must stay inside the companion runtime`)
  }
  return segments.join("/")
}

function isInside(root: string, candidate: string) {
  const relative = path.relative(root, candidate)
  return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
}

function snapshot(stat: {
  ctimeMs: number | bigint
  dev: number | bigint
  ino: number | bigint
  mtimeMs: number | bigint
  size: number | bigint
}) {
  return {
    ctimeMs: stat.ctimeMs,
    dev: stat.dev,
    ino: stat.ino,
    mtimeMs: stat.mtimeMs,
    size: stat.size,
  }
}

function sameSnapshot(left: VerifiedRuntimeFile["snapshot"], right: VerifiedRuntimeFile["snapshot"]) {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs
  )
}

async function digestFile(handle: Awaited<ReturnType<typeof fs.open>>, size: number, signal?: AbortSignal) {
  const digest = createHash("sha256")
  const buffer = Buffer.alloc(1024 * 1024)
  let position = 0
  while (position < size) {
    if (signal?.aborted) throw signal.reason ?? new DOMException("Canceled", "AbortError")
    const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, size - position), position)
    if (bytesRead === 0) throw new Error("Companion runtime file ended during verification")
    digest.update(buffer.subarray(0, bytesRead))
    position += bytesRead
  }
  return digest.digest("hex")
}

async function verifyFile(
  realRoot: string,
  descriptor: RuntimeFileDescriptor,
  executable: boolean,
  label: string,
  signal?: AbortSignal,
): Promise<VerifiedRuntimeFile> {
  const relativePath = portableRelativePath(descriptor.relativePath, `${label} path`)
  if (!Number.isSafeInteger(descriptor.byteSize) || descriptor.byteSize < 1 || descriptor.byteSize > maximumRuntimeFileBytes) {
    throw new Error(`${label} byte size is invalid`)
  }
  if (!/^[a-f0-9]{64}$/u.test(descriptor.sha256)) throw new Error(`${label} SHA-256 is invalid`)
  const candidate = path.join(realRoot, ...relativePath.split("/"))
  const before = await fs.lstat(candidate)
  if (before.isSymbolicLink() || !before.isFile() || before.size !== descriptor.byteSize) {
    throw new Error(`${label} is not the pinned regular file`)
  }
  const realPath = await fs.realpath(candidate)
  if (!isInside(realRoot, realPath)) throw new Error(`${label} escaped the companion runtime`)
  const handle = await fs.open(realPath, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0))
  try {
    const opened = await handle.stat()
    const openedSnapshot = snapshot(opened)
    if (!opened.isFile() || !sameSnapshot(snapshot(before), openedSnapshot)) {
      throw new Error(`${label} changed during verification`)
    }
    if ((await digestFile(handle, opened.size, signal)) !== descriptor.sha256) {
      throw new Error(`${label} checksum does not match the pinned runtime inventory`)
    }
    if (executable && process.platform !== "win32") await fs.access(realPath, fsConstants.X_OK)
    return {
      byteSize: descriptor.byteSize,
      executable,
      path: realPath,
      relativePath,
      sha256: descriptor.sha256,
      snapshot: openedSnapshot,
    }
  } finally {
    await handle.close()
  }
}

export async function assertRuntimeFileStable(file: VerifiedRuntimeFile) {
  const before = await fs.lstat(file.path)
  if (before.isSymbolicLink() || !before.isFile() || !sameSnapshot(file.snapshot, snapshot(before))) {
    throw new Error("Companion runtime inventory changed after verification")
  }
  if (await fs.realpath(file.path) !== file.path) throw new Error("Companion runtime inventory path changed")
  const handle = await fs.open(file.path, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0))
  try {
    const opened = await handle.stat()
    if (!opened.isFile() || !sameSnapshot(file.snapshot, snapshot(opened))) {
      throw new Error("Companion runtime inventory changed after verification")
    }
  } finally {
    await handle.close()
  }
  if (file.executable && process.platform !== "win32") await fs.access(file.path, fsConstants.X_OK)
}

export async function verifyRuntimeInventory(
  descriptor: SubtitleRuntimeInventoryDescriptor,
  signal?: AbortSignal,
): Promise<VerifiedSubtitleRuntimeInventory> {
  if (!path.isAbsolute(descriptor.rootDirectory)) throw new Error("Companion runtime root must be absolute")
  if (typeof descriptor.version !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(descriptor.version)) {
    throw new Error("Companion runtime version is invalid")
  }
  const rootStatus = await fs.lstat(descriptor.rootDirectory)
  if (rootStatus.isSymbolicLink() || !rootStatus.isDirectory()) {
    throw new Error("Companion runtime root is not a regular directory")
  }
  const realRoot = await fs.realpath(descriptor.rootDirectory)
  const [ffmpeg, ffprobe, whisper] = await Promise.all([
    verifyFile(realRoot, descriptor.ffmpeg, true, "FFmpeg", signal),
    verifyFile(realRoot, descriptor.ffprobe, true, "FFprobe", signal),
    verifyFile(realRoot, descriptor.whisper, true, "Whisper", signal),
  ])
  const modelEntries = await Promise.all(
    (Object.entries(descriptor.models) as Array<[SubtitleModelSize, RuntimeFileDescriptor]>).map(
      async ([model, value]) => [model, await verifyFile(realRoot, value, false, `Whisper ${model} model`, signal)] as const,
    ),
  )
  const models = Object.fromEntries(modelEntries) as Partial<Record<SubtitleModelSize, VerifiedRuntimeFile>>
  let hardErase: VerifiedSubtitleRuntimeInventory["hardErase"]
  if (descriptor.hardErase) {
    const [executable, detectorModel, inpaintingModel] = await Promise.all([
      verifyFile(realRoot, descriptor.hardErase.executable, true, "Hard subtitle executable", signal),
      verifyFile(realRoot, descriptor.hardErase.detectorModel, false, "Hard subtitle detector model", signal),
      verifyFile(realRoot, descriptor.hardErase.inpaintingModel, false, "Hard subtitle inpainting model", signal),
    ])
    if (path.dirname(executable.path) !== path.dirname(ffmpeg.path)) {
      throw new Error("Hard subtitle executable and FFmpeg must be sibling runtime files")
    }
    hardErase = { detectorModel, executable, inpaintingModel }
  }
  const relativePaths = [ffmpeg, ffprobe, whisper, ...Object.values(models), ...(hardErase ? Object.values(hardErase) : [])]
    .map((file) => file.relativePath)
  if (new Set(relativePaths).size !== relativePaths.length) {
    throw new Error("Companion runtime inventory reuses one file for multiple roles")
  }
  return {
    ffmpeg,
    ffprobe,
    ...(hardErase ? { hardErase } : {}),
    models,
    rootDirectory: realRoot,
    version: descriptor.version,
    whisper,
  }
}

/** Release composition gate: the installed companion must be wholly usable. */
export function assertCompleteSubtitleRuntimeInventory(
  inventory: VerifiedSubtitleRuntimeInventory,
): asserts inventory is CompleteVerifiedSubtitleRuntimeInventory {
  if (!inventory.models.tiny || !inventory.models.base || !inventory.models.small || !inventory.hardErase) {
    throw new Error("Companion subtitle runtime inventory is incomplete")
  }
}
