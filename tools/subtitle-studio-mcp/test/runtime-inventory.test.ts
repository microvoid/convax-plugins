import { afterEach, describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import {
  assertCompleteSubtitleRuntimeInventory,
  assertRuntimeFileStable,
  verifyRuntimeInventory,
  type RuntimeFileDescriptor,
  type SubtitleRuntimeInventoryDescriptor,
} from "../src/runtime/inventory"

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => fs.rm(directory, { force: true, recursive: true })))
})

async function fixture(includeHard = true): Promise<SubtitleRuntimeInventoryDescriptor> {
  const rootDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "subtitle-runtime-inventory-"))
  temporaryDirectories.push(rootDirectory)
  const create = async (relativePath: string, contents: string, executable = false): Promise<RuntimeFileDescriptor> => {
    const filePath = path.join(rootDirectory, relativePath)
    await fs.mkdir(path.dirname(filePath), { recursive: true })
    const bytes = Buffer.from(contents)
    await fs.writeFile(filePath, bytes)
    if (executable) await fs.chmod(filePath, 0o700)
    return {
      byteSize: bytes.length,
      relativePath,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    }
  }
  const [ffmpeg, ffprobe, whisper, tiny, base, small, executable, detectorModel, inpaintingModel] = await Promise.all([
    create("bin/ffmpeg", "ffmpeg-v1", true),
    create("bin/ffprobe", "ffprobe-v1", true),
    create("bin/whisper-cli", "whisper-v1", true),
    create("models/ggml-tiny.bin", "tiny-model"),
    create("models/ggml-base.bin", "base-model"),
    create("models/ggml-small.bin", "small-model"),
    create("bin/hard-subtitle", "hard-sidecar-v1", true),
    create("models/text-detector.onnx", "detector-model"),
    create("models/inpainting.onnx", "inpainting-model"),
  ])
  return {
    ffmpeg,
    ffprobe,
    ...(includeHard ? { hardErase: { detectorModel, executable, inpaintingModel } } : {}),
    models: { base, small, tiny },
    rootDirectory,
    version: "2026.07.21",
    whisper,
  }
}

describe("verified companion runtime inventory", () => {
  test("pins every executable and model to the companion root and admits a complete release", async () => {
    const inventory = await verifyRuntimeInventory(await fixture())
    assertCompleteSubtitleRuntimeInventory(inventory)
    expect(inventory.ffmpeg.path.startsWith(`${inventory.rootDirectory}${path.sep}`)).toBe(true)
    expect(inventory.models.tiny.path).toEndWith("models/ggml-tiny.bin")
    expect(inventory.hardErase.executable.path).toEndWith("bin/hard-subtitle")
    await Promise.all([
      assertRuntimeFileStable(inventory.ffmpeg),
      assertRuntimeFileStable(inventory.whisper),
      assertRuntimeFileStable(inventory.models.small),
      assertRuntimeFileStable(inventory.hardErase.inpaintingModel),
    ])
  })

  test("rejects checksum changes, symlinks, and incomplete release composition", async () => {
    const descriptor = await fixture(false)
    const inventory = await verifyRuntimeInventory(descriptor)
    expect(() => assertCompleteSubtitleRuntimeInventory(inventory)).toThrow("incomplete")

    await fs.writeFile(path.join(descriptor.rootDirectory, descriptor.ffmpeg.relativePath), "tampered")
    await expect(verifyRuntimeInventory(descriptor)).rejects.toThrow()

    const linked = await fixture()
    const target = path.join(linked.rootDirectory, linked.models.tiny!.relativePath)
    const symlink = path.join(linked.rootDirectory, "models/linked-tiny.bin")
    await fs.symlink(target, symlink)
    linked.models.tiny = { ...linked.models.tiny!, relativePath: "models/linked-tiny.bin" }
    await expect(verifyRuntimeInventory(linked)).rejects.toThrow("pinned regular file")
  })

  test("detects a runtime file replaced after initial verification", async () => {
    const descriptor = await fixture()
    const inventory = await verifyRuntimeInventory(descriptor)
    await fs.writeFile(inventory.whisper.path, "whisper-v2")
    await expect(assertRuntimeFileStable(inventory.whisper)).rejects.toThrow("changed")
  })
})
