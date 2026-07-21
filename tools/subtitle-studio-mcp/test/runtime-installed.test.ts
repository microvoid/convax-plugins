import { afterEach, describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import { installedSubtitleRuntimeSchema, loadInstalledSubtitleRuntime } from "../src/runtime/installed"
import type { RuntimeFileDescriptor } from "../src/runtime/inventory"

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => fs.rm(directory, { force: true, recursive: true })))
})

async function installedFixture() {
  const bundle = await fs.mkdtemp(path.join(os.tmpdir(), "subtitle-installed-runtime-"))
  temporaryDirectories.push(bundle)
  const runtime = path.join(bundle, "runtime")
  await fs.mkdir(runtime)
  const create = async (relativePath: string, value: string, executable = false): Promise<RuntimeFileDescriptor> => {
    const target = path.join(runtime, relativePath)
    await fs.mkdir(path.dirname(target), { recursive: true })
    const bytes = Buffer.from(value)
    await fs.writeFile(target, bytes)
    if (executable) await fs.chmod(target, 0o700)
    return { byteSize: bytes.length, relativePath, sha256: createHash("sha256").update(bytes).digest("hex") }
  }
  const [ffmpeg, ffprobe, whisper, tiny, base, small, executable, detectorModel, inpaintingModel] = await Promise.all([
    create("bin/ffmpeg", "ffmpeg", true),
    create("bin/ffprobe", "ffprobe", true),
    create("bin/whisper", "whisper", true),
    create("models/tiny.bin", "tiny"),
    create("models/base.bin", "base"),
    create("models/small.bin", "small"),
    create("bin/hard-sidecar", "hard", true),
    create("models/detector.onnx", "detector"),
    create("models/inpainting.onnx", "inpainting"),
  ])
  const manifest = {
    ffmpeg,
    ffprobe,
    hardErase: { detectorModel, executable, inpaintingModel },
    models: { base, small, tiny },
    schema: installedSubtitleRuntimeSchema,
    version: "installed-test",
    whisper,
  }
  await fs.writeFile(path.join(runtime, "inventory.json"), JSON.stringify(manifest))
  return { bundle, executablePath: path.join(bundle, "convax-subtitle-studio-mcp"), manifest, runtime }
}

describe("installed companion runtime discovery", () => {
  test("loads only the fixed sibling runtime tree and verifies a complete inventory", async () => {
    const fixture = await installedFixture()
    const inventory = await loadInstalledSubtitleRuntime(fixture.executablePath)
    expect(inventory.rootDirectory).toBe(await fs.realpath(fixture.runtime))
    expect(inventory.models).toMatchObject({ base: { sha256: fixture.manifest.models.base.sha256 } })
    expect(inventory.hardErase.executable.relativePath).toBe("bin/hard-sidecar")
  })

  test("rejects manifest path injection, unknown fields, and symlink replacement", async () => {
    const fixture = await installedFixture()
    const manifestPath = path.join(fixture.runtime, "inventory.json")
    await fs.writeFile(manifestPath, JSON.stringify({ ...fixture.manifest, rootDirectory: "/tmp/untrusted" }))
    await expect(loadInstalledSubtitleRuntime(fixture.executablePath)).rejects.toThrow("unsupported fields")

    const replacement = path.join(fixture.bundle, "replacement.json")
    await fs.writeFile(replacement, JSON.stringify(fixture.manifest))
    await fs.rm(manifestPath)
    await fs.symlink(replacement, manifestPath)
    await expect(loadInstalledSubtitleRuntime(fixture.executablePath)).rejects.toThrow("invalid")
  })
})
