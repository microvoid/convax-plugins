import { constants as fsConstants } from "node:fs"
import fs from "node:fs/promises"
import path from "node:path"

import {
  assertCompleteSubtitleRuntimeInventory,
  verifyRuntimeInventory,
  type CompleteVerifiedSubtitleRuntimeInventory,
  type RuntimeFileDescriptor,
  type SubtitleRuntimeInventoryDescriptor,
} from "./inventory"

export const installedSubtitleRuntimeSchema = "convax.subtitle-runtime/1" as const

interface InstalledSubtitleRuntimeManifest {
  ffmpeg: RuntimeFileDescriptor
  ffprobe: RuntimeFileDescriptor
  hardErase: NonNullable<SubtitleRuntimeInventoryDescriptor["hardErase"]>
  models: {
    base: RuntimeFileDescriptor
    small: RuntimeFileDescriptor
    tiny: RuntimeFileDescriptor
  }
  schema: typeof installedSubtitleRuntimeSchema
  version: string
  whisper: RuntimeFileDescriptor
}

const maximumInventoryBytes = 64 * 1024

/**
 * Resolves only the fixed runtime tree adjacent to the installed companion.
 * Neither environment variables nor host PATH participate in discovery.
 */
export async function loadInstalledSubtitleRuntime(
  companionExecutablePath = process.execPath,
  signal?: AbortSignal,
): Promise<CompleteVerifiedSubtitleRuntimeInventory> {
  if (!path.isAbsolute(companionExecutablePath)) throw new Error("Companion executable path must be absolute")
  const runtimeDirectory = path.join(path.dirname(companionExecutablePath), "runtime")
  const directory = await fs.lstat(runtimeDirectory)
  if (directory.isSymbolicLink() || !directory.isDirectory()) throw new Error("Installed runtime is unavailable")
  const realRuntimeDirectory = await fs.realpath(runtimeDirectory)
  const manifestPath = path.join(realRuntimeDirectory, "inventory.json")
  const manifestStatus = await fs.lstat(manifestPath)
  if (
    manifestStatus.isSymbolicLink() ||
    !manifestStatus.isFile() ||
    manifestStatus.size < 2 ||
    manifestStatus.size > maximumInventoryBytes
  ) {
    throw new Error("Installed runtime inventory is invalid")
  }
  const handle = await fs.open(manifestPath, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0))
  let serialized: string
  try {
    const opened = await handle.stat()
    if (
      !opened.isFile() ||
      opened.dev !== manifestStatus.dev ||
      opened.ino !== manifestStatus.ino ||
      opened.size !== manifestStatus.size
    ) {
      throw new Error("Installed runtime inventory changed while opening")
    }
    serialized = await handle.readFile("utf8")
  } finally {
    await handle.close()
  }
  if (signal?.aborted) throw signal.reason ?? new DOMException("Canceled", "AbortError")
  let value: unknown
  try {
    value = JSON.parse(serialized)
  } catch {
    throw new Error("Installed runtime inventory is not JSON")
  }
  const manifest = parseManifest(value)
  const inventory = await verifyRuntimeInventory(
    {
      ffmpeg: manifest.ffmpeg,
      ffprobe: manifest.ffprobe,
      hardErase: manifest.hardErase,
      models: manifest.models,
      rootDirectory: realRuntimeDirectory,
      version: manifest.version,
      whisper: manifest.whisper,
    },
    signal,
  )
  assertCompleteSubtitleRuntimeInventory(inventory)
  return inventory
}

function parseManifest(value: unknown): InstalledSubtitleRuntimeManifest {
  const manifest = record(value, "Installed runtime inventory")
  exactKeys(manifest, ["ffmpeg", "ffprobe", "hardErase", "models", "schema", "version", "whisper"], "Installed runtime inventory")
  if (manifest.schema !== installedSubtitleRuntimeSchema) throw new Error("Installed runtime inventory schema is unsupported")
  const models = record(manifest.models, "Installed Whisper models")
  exactKeys(models, ["base", "small", "tiny"], "Installed Whisper models")
  const hardErase = record(manifest.hardErase, "Installed hard subtitle runtime")
  exactKeys(hardErase, ["detectorModel", "executable", "inpaintingModel"], "Installed hard subtitle runtime")
  return {
    ffmpeg: parseFile(manifest.ffmpeg, "FFmpeg"),
    ffprobe: parseFile(manifest.ffprobe, "FFprobe"),
    hardErase: {
      detectorModel: parseFile(hardErase.detectorModel, "Hard subtitle detector model"),
      executable: parseFile(hardErase.executable, "Hard subtitle executable"),
      inpaintingModel: parseFile(hardErase.inpaintingModel, "Hard subtitle inpainting model"),
    },
    models: {
      base: parseFile(models.base, "Whisper base model"),
      small: parseFile(models.small, "Whisper small model"),
      tiny: parseFile(models.tiny, "Whisper tiny model"),
    },
    schema: installedSubtitleRuntimeSchema,
    version: manifest.version as string,
    whisper: parseFile(manifest.whisper, "Whisper executable"),
  }
}

function parseFile(value: unknown, label: string): RuntimeFileDescriptor {
  const file = record(value, label)
  exactKeys(file, ["byteSize", "relativePath", "sha256"], label)
  return {
    byteSize: file.byteSize as number,
    relativePath: file.relativePath as string,
    sha256: file.sha256 as string,
  }
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`)
  return value as Record<string, unknown>
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[], label: string) {
  const expected = new Set(keys)
  if (Object.keys(value).length !== expected.size || Object.keys(value).some((key) => !expected.has(key))) {
    throw new Error(`${label} contains unsupported fields`)
  }
}
