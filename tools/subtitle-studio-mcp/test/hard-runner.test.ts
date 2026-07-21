import { afterEach, describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import { createHardSubtitleEraseSidecarRunner, type VerifiedHardSubtitleRuntime } from "../src/runtime/hard-runner"
import { verifyRuntimeInventory, type RuntimeFileDescriptor } from "../src/runtime/inventory"

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => fs.rm(directory, { force: true, recursive: true })))
})

async function verifiedRuntime(sidecarSource: string): Promise<VerifiedHardSubtitleRuntime> {
  const rootDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "subtitle-hard-runtime-"))
  temporaryDirectories.push(rootDirectory)
  const create = async (relativePath: string, contents: string, executable = false): Promise<RuntimeFileDescriptor> => {
    const filePath = path.join(rootDirectory, relativePath)
    await fs.mkdir(path.dirname(filePath), { recursive: true })
    const bytes = Buffer.from(contents)
    await fs.writeFile(filePath, bytes)
    if (executable) await fs.chmod(filePath, 0o700)
    return { byteSize: bytes.length, relativePath, sha256: createHash("sha256").update(bytes).digest("hex") }
  }
  const [ffmpeg, ffprobe, whisper, executable, detectorModel, inpaintingModel] = await Promise.all([
    create("bin/ffmpeg", "fake ffmpeg", true),
    create("bin/ffprobe", "fake ffprobe", true),
    create("bin/whisper", "fake whisper", true),
    create("bin/hard-sidecar", sidecarSource, true),
    create("models/detector.onnx", "detector"),
    create("models/inpainting.onnx", "inpainting"),
  ])
  const inventory = await verifyRuntimeInventory({
    ffmpeg,
    ffprobe,
    hardErase: { detectorModel, executable, inpaintingModel },
    models: {},
    rootDirectory,
    version: "test-v1",
    whisper,
  })
  return { ...inventory.hardErase!, ffmpeg: inventory.ffmpeg, version: inventory.version }
}

async function runInput(runtime: VerifiedHardSubtitleRuntime) {
  const workDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "subtitle-hard-work-"))
  temporaryDirectories.push(workDirectory)
  const sourcePath = path.join(workDirectory, "source.mp4")
  await fs.writeFile(sourcePath, Buffer.from("source video"))
  return {
    durationMs: 2_000,
    height: 720,
    outputRelativePath: "hard-erased.mp4",
    region: { height: 120, width: 1_000, x: 20, y: 560 },
    report: () => undefined,
    runtime,
    signal: new AbortController().signal,
    sourcePath,
    width: 1_280,
    workDirectory,
  }
}

const successSidecar = `#!${process.execPath}
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", chunk => input += chunk);
process.stdin.on("end", async () => {
  const request = JSON.parse(input);
  await Bun.write("request.json", JSON.stringify(request));
  await Bun.write(request.output.path, new Uint8Array([0,0,0,12,102,116,121,112,105,115,111,109]));
  process.stdout.write(JSON.stringify({protocolVersion:1,type:"progress",progress:0.5,stage:"inpainting"}) + "\\n");
  process.stdout.write(JSON.stringify({protocolVersion:1,type:"result",outputPath:request.output.path}) + "\\n");
});
`

describe("hard subtitle sidecar boundary", () => {
  test("passes a bounded request over stdin and accepts only the requested regular MP4", async () => {
    const runtime = await verifiedRuntime(successSidecar)
    const input = await runInput(runtime)
    const reports: Array<[number, string]> = []
    const result = await createHardSubtitleEraseSidecarRunner()({
      ...input,
      report: (progress, stage) => reports.push([progress, stage]),
    })
    expect(result.outputRelativePath).toBe("hard-erased.mp4")
    expect(await fs.readFile(result.outputPath)).toHaveLength(12)
    const request = JSON.parse(await fs.readFile(path.join(input.workDirectory, "request.json"), "utf8"))
    expect(request).toMatchObject({
      operation: "erase-hard-subtitles",
      output: { path: "hard-erased.mp4" },
      protocolVersion: 1,
      region: input.region,
    })
    expect(request.models.detectorPath).toBe(runtime.detectorModel.path)
    expect(reports).toEqual([[0.5, "inpainting"]])
  })

  test("rejects a sidecar result that tries to escape the host output directory", async () => {
    const runtime = await verifiedRuntime(`#!${process.execPath}\nprocess.stdin.resume(); process.stdin.on("end", () => process.stdout.write(JSON.stringify({protocolVersion:1,type:"result",outputPath:"../escape.mp4"}) + "\\n"));\n`)
    await expect(createHardSubtitleEraseSidecarRunner()(await runInput(runtime))).rejects.toThrow()
  })

  test("terminates the sidecar when the operation is cancelled", async () => {
    const runtime = await verifiedRuntime(`#!${process.execPath}\nprocess.stdin.resume(); setInterval(() => undefined, 1000);\n`)
    const input = await runInput(runtime)
    const controller = new AbortController()
    const running = createHardSubtitleEraseSidecarRunner({ terminationGraceMs: 20 })({
      ...input,
      signal: controller.signal,
    })
    await Bun.sleep(20)
    controller.abort(new DOMException("Cancelled hard erase", "AbortError"))
    await expect(running).rejects.toThrow("Cancelled hard erase")
  })
})
