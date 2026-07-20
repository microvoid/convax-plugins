import { afterAll, describe, expect, test } from "bun:test"
import { promises as fs } from "node:fs"
import os from "node:os"
import path from "node:path"
import vm from "node:vm"
import { buildIndex } from "./build-index.mjs"
import { checkReleaseCoverage } from "./check-release-coverage.mjs"
import { fetchReleaseEntries } from "./fetch-release-entries.mjs"
import { discoverPackages, parseRegistry, readStoredZip, root, sha256 } from "./lib.mjs"
import { packPackages } from "./pack.mjs"

const temporaryDirectories = []
async function temporaryDirectory() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "convax-plugins-"))
  temporaryDirectories.push(directory)
  return directory
}

afterAll(async () => {
  await Promise.all(temporaryDirectories.map((directory) => fs.rm(directory, { recursive: true, force: true })))
})

describe("source packages", () => {
  test("validates the complete Plugin and Skill catalog", async () => {
    const packages = await discoverPackages()
    expect(packages.map((pkg) => `${pkg.metadata.kind}/${pkg.metadata.id}`)).toEqual([
      "plugin/ffmpeg-tools",
      "plugin/hello-convax",
      "plugin/xiaoyunque-generation",
      "skill/ad-idea",
      "skill/audiobook",
      "skill/clip-export",
      "skill/ecommerce-image",
      "skill/ffmpeg-canvas",
      "skill/film-shot",
      "skill/hello-convax-guide",
      "skill/image-remix",
      "skill/short-drama-screenwriter",
      "skill/skill-creator",
      "skill/skill-reviewer",
      "skill/video-prompting",
    ])
    const ffmpeg = packages.find((pkg) => pkg.metadata.id === "ffmpeg-tools")
    const ffmpegSkill = packages.find((pkg) => pkg.metadata.kind === "skill" && pkg.metadata.id === "ffmpeg-canvas")
    const hello = packages.find((pkg) => pkg.metadata.id === "hello-convax")
    const xiaoyunque = packages.find((pkg) => pkg.metadata.id === "xiaoyunque-generation")
    expect(hello.manifest.schema).toBe("convax.plugin/1")
    expect(hello.manifest.capabilities).toEqual([])
    expect(xiaoyunque.manifest).toEqual(expect.objectContaining({
      capabilities: [],
      runtime: { command: "convax-xiaoyunque-mcp", type: "mcp-stdio" },
      schema: "convax.plugin/2",
    }))
    expect(xiaoyunque.manifest.contributes.service).toEqual({
      actions: ["authorize", "reauthorize", "authorization.cancel", "sign_out"],
    })
    const generationTools = xiaoyunque.manifest.contributes.generation.tools
    expect(generationTools.map((tool) => tool.id)).toEqual([
      "image.seedream_5.0_pro",
      "image.seedream_5.0",
      "image.seedream_4.3",
      "image.seedream_4.5",
      "image.seedream_4.1",
      "image.seedream_4",
      "image.nano_banana_pro_1",
      "image.gpt_image_2",
      "video.seedance_2.0_mini_lite",
      "video.seedance_2.0_mini",
      "video.seedance2.0_fast_vision",
      "video.seedance2.0_vision",
      "video.seedance2.0_fast_direct",
      "video.seedance2.0_direct",
      "video.seedance1.5_direct",
      "video.seedance_1.0_fast",
    ])
    for (const tool of generationTools) {
      expect(tool.acceptedInputs).toEqual(tool.output === "image" || tool.id === "video.seedance_1.0_fast"
        ? ["reference_image"]
        : ["reference_image", "reference_video", "first_frame", "last_frame", "audio"])
    }
    expect(xiaoyunque.metadata.companions).toEqual([{
      command: "convax-xiaoyunque-mcp",
      version: "0.2.12",
      source: "tools/xiaoyunque-mcp",
      targets: [{
        platform: "darwin",
        arch: "arm64",
        path: "dist/darwin-arm64/convax-xiaoyunque-mcp",
      }],
    }])
    expect(xiaoyunque.manifest).not.toHaveProperty("entry")
    expect(ffmpeg.manifest).toEqual(expect.objectContaining({
      runtime: { command: "convax-ffmpeg-mcp", type: "mcp-stdio" },
      schema: "convax.plugin/2",
    }))
    expect(ffmpeg.manifest.contributes.generation.tools.map((tool) => [tool.id, tool.output])).toEqual([
      ["run.image", "image"],
      ["run.video", "video"],
      ["run.audio", "audio"],
    ])
    for (const tool of ffmpeg.manifest.contributes.generation.tools) {
      expect(tool.acceptedInputs).toEqual([
        "reference_image",
        "reference_video",
        "first_frame",
        "last_frame",
        "audio",
      ])
    }
    expect(ffmpeg.manifest.skill).toBe("skills/ffmpeg-canvas/SKILL.md")
    for (const source of ffmpegSkill.files) {
      const embedded = ffmpeg.files.find((file) => file.relativePath === `skills/ffmpeg-canvas/${source.relativePath}`)
      expect(embedded?.data).toEqual(source.data)
    }
    expect(ffmpeg.metadata.companions).toEqual([{
      command: "convax-ffmpeg-mcp",
      version: "0.1.0",
      source: "tools/ffmpeg-mcp",
      targets: [{
        platform: "darwin",
        arch: "arm64",
        path: "dist/darwin-arm64/convax-ffmpeg-mcp",
      }],
    }])
  })

  test("creates byte-identical ZIPs with required root entries", async () => {
    const packages = await discoverPackages()
    const first = await packPackages(packages, path.join(await temporaryDirectory(), "first"))
    const second = await packPackages(packages, path.join(await temporaryDirectory(), "second"))
    expect(first.map((item) => sha256(item.zip))).toEqual(second.map((item) => sha256(item.zip)))
    const byId = (id) => first.find((item) => item.pkg.metadata.id === id)
    const hello = byId("hello-convax")
    const xiaoyunque = byId("xiaoyunque-generation")
    const skill = byId("ad-idea")
    const ffmpeg = byId("ffmpeg-tools")
    expect(readStoredZip(hello.zip).map((entry) => entry.relativePath)).toContain("manifest.json")
    expect(readStoredZip(xiaoyunque.zip).map((entry) => entry.relativePath)).toEqual(["LICENSE", "manifest.json"])
    expect(xiaoyunque.companionAssets.map((asset) => asset.assetName)).toEqual([
      "convax-companion-convax-xiaoyunque-mcp-0.2.12-darwin-arm64",
    ])
    expect(xiaoyunque.tag).toBe("plugin-xiaoyunque-generation-v0.2.12")
    expect(await fs.readFile(xiaoyunque.companionAssets[0].path)).toEqual(xiaoyunque.companionAssets[0].data)
    expect(readStoredZip(skill.zip).map((entry) => entry.relativePath)).toContain("SKILL.md")
    expect(readStoredZip(ffmpeg.zip).map((entry) => entry.relativePath)).toEqual([
      "FFMPEG-CREDITS",
      "FFMPEG-LICENSE",
      "FFMPEG-UPSTREAM-LICENSE.md",
      "LICENSE",
      "README.md",
      "THIRD_PARTY_NOTICES.md",
      "manifest.json",
      "skills/ffmpeg-canvas/LICENSE",
      "skills/ffmpeg-canvas/SKILL.md",
      "skills/ffmpeg-canvas/agents/openai.yaml",
      "skills/ffmpeg-canvas/references/convax.md",
    ])
    expect(ffmpeg.companionAssets.map((asset) => asset.assetName)).toEqual([
      "convax-companion-convax-ffmpeg-mcp-0.1.0-darwin-arm64",
    ])
    const ffmpegLicense = readStoredZip(ffmpeg.zip).find((entry) => entry.relativePath === "FFMPEG-LICENSE")
    expect(ffmpegLicense?.data).toEqual(await fs.readFile(path.join(root, "tools", "ffmpeg-mcp", "FFMPEG-LICENSE")))
  })

  test("builds the strict client Registry with only the latest stable version", async () => {
    const packages = await discoverPackages()
    const directory = await temporaryDirectory()
    const packed = path.join(directory, "packages")
    const output = path.join(directory, "registry", "v1", "index.json")
    const packedResults = await packPackages(packages, packed)
    const hello = packedResults.find((item) => item.pkg.metadata.id === "hello-convax")
    const newer = structuredClone(hello.entry)
    newer.version = "0.2.0"
    newer.manifest.version = "0.2.0"
    newer.artifact.url = newer.artifact.url.replaceAll("0.1.0", "0.2.0")
    const newerDirectory = path.join(packed, "plugin-hello-convax-v0.2.0")
    await fs.mkdir(newerDirectory)
    await fs.writeFile(path.join(newerDirectory, "registry-entry.json"), `${JSON.stringify(newer, null, 2)}\n`)
    const registry = await buildIndex({ entriesDirectory: packed, outputFile: output, revision: "a".repeat(40), sequence: 7 })
    expect(parseRegistry(JSON.parse(await fs.readFile(output, "utf8")))).toEqual(registry)
    expect(Object.keys(registry)).toEqual(["schema", "sequence", "revision", "packages"])
    const helloEntry = registry.packages.find((item) => item.id === "hello-convax")
    const xiaoyunqueEntry = registry.packages.find((item) => item.id === "xiaoyunque-generation")
    const firstSkill = registry.packages.find((item) => item.kind === "skill")
    expect(helloEntry.version).toBe("0.2.0")
    expect(helloEntry.artifact.url).toContain("/plugin-hello-convax-v0.2.0/")
    expect(xiaoyunqueEntry.manifest.schema).toBe("convax.plugin/2")
    expect(xiaoyunqueEntry.companions[0].targets[0].artifact.url).toContain(
      "/convax-companion-convax-xiaoyunque-mcp-0.2.12-darwin-arm64",
    )
    expect(firstSkill).not.toHaveProperty("manifest")
  })

  test("requires a Release ZIP whose size matches its Registry entry", async () => {
    const packages = await discoverPackages()
    const directory = await temporaryDirectory()
    const hello = packages.find((pkg) => pkg.metadata.id === "hello-convax")
    const [packed] = await packPackages([hello], path.join(directory, "packed"))
    const release = {
      assets: [
        { name: "registry-entry.json", url: "https://api.github.test/assets/entry" },
        { name: packed.assetName, size: packed.zip.length },
      ],
      draft: false,
      tag_name: packed.tag,
    }
    const fetchImpl = async (url) => {
      if (String(url).includes("/releases?")) return new Response(JSON.stringify([release]))
      if (url === "https://api.github.test/assets/entry") return new Response(JSON.stringify(packed.entry))
      throw new Error(`Unexpected URL ${url}`)
    }
    const output = path.join(directory, "release-entries")
    expect(await fetchReleaseEntries({ outputDirectory: output, token: "test", fetchImpl })).toBe(1)
    expect(JSON.parse(await fs.readFile(path.join(output, packed.tag, "registry-entry.json"), "utf8"))).toEqual(packed.entry)

    release.assets[1].size += 1
    await expect(fetchReleaseEntries({ outputDirectory: output, token: "test", fetchImpl })).rejects.toThrow("size does not match")
  })

  test("downloads and verifies every declared companion executable", async () => {
    const packages = await discoverPackages()
    const directory = await temporaryDirectory()
    const xiaoyunque = packages.find((pkg) => pkg.metadata.id === "xiaoyunque-generation")
    const [packed] = await packPackages([xiaoyunque], path.join(directory, "packed"))
    const companion = packed.companionAssets[0]
    const descriptor = packed.entry.companions[0].targets[0].artifact
    const companionAsset = {
      name: companion.assetName,
      size: descriptor.size,
      url: "https://api.github.test/assets/companion",
      browser_download_url: descriptor.url,
      digest: `sha256:${descriptor.sha256}`,
    }
    const release = {
      assets: [
        { name: "registry-entry.json", url: "https://api.github.test/assets/entry" },
        { name: packed.assetName, size: packed.zip.length },
        companionAsset,
      ],
      draft: false,
      tag_name: packed.tag,
    }
    let companionBytes = companion.data
    const fetchImpl = async (url) => {
      if (String(url).includes("/releases?")) return new Response(JSON.stringify([release]))
      if (url === "https://api.github.test/assets/entry") return new Response(JSON.stringify(packed.entry))
      if (url === companionAsset.url) return new Response(companionBytes)
      throw new Error(`Unexpected URL ${url}`)
    }
    const output = path.join(directory, "release-entries")
    expect(await fetchReleaseEntries({ outputDirectory: output, token: "test", fetchImpl })).toBe(1)

    companionAsset.size += 1
    await expect(fetchReleaseEntries({ outputDirectory: output, token: "test", fetchImpl })).rejects.toThrow(
      "size does not match Registry entry",
    )
    companionAsset.size = descriptor.size
    companionAsset.digest = `sha256:${"0".repeat(64)}`
    await expect(fetchReleaseEntries({ outputDirectory: output, token: "test", fetchImpl })).rejects.toThrow(
      "digest does not match Registry entry",
    )
    companionAsset.digest = `sha256:${descriptor.sha256}`
    companionBytes = Buffer.from(companion.data)
    companionBytes[0] ^= 0xff
    await expect(fetchReleaseEntries({ outputDirectory: output, token: "test", fetchImpl })).rejects.toThrow(
      "SHA-256 does not match Registry entry",
    )
  })

  test("defers Registry deployment until every source version has a Release entry", async () => {
    const packages = await discoverPackages()
    const directory = await temporaryDirectory()
    const results = await packPackages(packages, directory)
    expect(await checkReleaseCoverage({ entriesDirectory: directory })).toEqual({ missing: [], ready: true })

    await fs.rm(results.at(-1).entryPath)
    expect(await checkReleaseCoverage({ entriesDirectory: directory })).toEqual({
      missing: [results.at(-1).tag],
      ready: false,
    })
  })
})

describe("hello-convax runtime", () => {
  test("accepts one scoped port and renders host.context.get", async () => {
    const elements = Object.fromEntries(["status", "context", "refresh"].map((id) => [id, {
      disabled: id === "refresh",
      listeners: {},
      textContent: "",
      addEventListener(type, listener) { this.listeners[type] = listener },
    }]))
    const listeners = new Map()
    const parent = {}
    const window = {
      parent,
      addEventListener(type, listener) { listeners.set(type, listener) },
      removeEventListener(type, listener) { if (listeners.get(type) === listener) listeners.delete(type) },
    }
    const sent = []
    const port = { onmessage: null, started: false, postMessage(message) { sent.push(message) }, start() { this.started = true } }
    const code = await fs.readFile(path.join(root, "packages/plugins/hello-convax/package/assets/app.js"), "utf8")
    vm.runInNewContext(code, { console, document: { getElementById: (id) => elements[id] }, Error, Map, Promise, window })

    listeners.get("message")({ data: { protocol: "convax.plugin-host/1", type: "connect", pluginId: "hello-convax" }, source: {}, ports: [port] })
    expect(port.started).toBe(false)
    listeners.get("message")({ data: { protocol: "convax.plugin-host/1", type: "connect", pluginId: "hello-convax" }, source: parent, ports: [port] })
    expect(port.started).toBe(true)
    expect(elements.refresh.disabled).toBe(false)
    expect(sent[0].method).toBe("host.context.get")
    port.onmessage({ data: { protocol: "convax.plugin-host/1", type: "response", id: sent[0].id, ok: true,
      result: { projectId: "project-test", canvasId: "canvas-test", nodeId: "node-test" } } })
    await Promise.resolve()
    expect(elements.status.textContent).toBe("Connected through convax.plugin-host/1.")
    expect(elements.context.textContent).toContain("canvas-test")

    port.onmessage({ data: { protocol: "convax.plugin-host/1", type: "command", command: "refresh" } })
    expect(sent).toHaveLength(2)
  })
})
