import { afterAll, describe, expect, test } from "bun:test"
import { promises as fs } from "node:fs"
import os from "node:os"
import path from "node:path"
import vm from "node:vm"
import { buildIndex } from "./build-index.mjs"
import { checkReleaseCoverage } from "./check-release-coverage.mjs"
import { fetchReleaseEntries } from "./fetch-release-entries.mjs"
import {
  composeOwnedSkillPackages,
  discoverPackages,
  maxPackageBytes,
  maxPluginEntries,
  parseRegistry,
  readStoredZip,
  root,
  sha256,
} from "./lib.mjs"
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
      "plugin/convax-pet",
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
    const violet = packages.find((pkg) => pkg.metadata.id === "convax-pet")
    const ffmpeg = packages.find((pkg) => pkg.metadata.id === "ffmpeg-tools")
    const ffmpegSkill = packages.find((pkg) => pkg.metadata.kind === "skill" && pkg.metadata.id === "ffmpeg-canvas")
    const hello = packages.find((pkg) => pkg.metadata.id === "hello-convax")
    const xiaoyunque = packages.find((pkg) => pkg.metadata.id === "xiaoyunque-generation")
    expect(violet.metadata.version).toBe("0.2.0")
    expect(violet.manifest.capabilities).toEqual([
      "pet.activity.read",
      "pet.activity.open",
      "pet.preferences.write",
    ])
    expect(violet.manifest.contributes.pet).toEqual({
      library: "pet-library.json",
      overlay: "pet/index.html",
      protocol: "convax.pet-host/1",
      settings: "settings/index.html",
    })
    expect(violet.manifest).not.toHaveProperty("entry")
    expect(violet.manifest).not.toHaveProperty("runtime")
    expect(violet.files.map((file) => file.relativePath)).toEqual(expect.arrayContaining([
      "assets/violet.webp",
      "pet-library.json",
      "pet/index.html",
      "settings/index.html",
    ]))
    expect(hello.manifest.schema).toBe("convax.plugin/1")
    expect(hello.manifest.capabilities).toEqual([])
    expect(xiaoyunque.manifest).toEqual(expect.objectContaining({
      capabilities: [],
      runtime: { command: "convax-xiaoyunque-mcp", type: "mcp-stdio" },
      schema: "convax.plugin/3",
    }))
    expect(xiaoyunque.manifest.contributes.service).toEqual({
      actions: ["authorize", "reauthorize", "authorization.cancel", "sign_out"],
    })
    const generationTools = xiaoyunque.manifest.contributes.generation.tools
    expect(xiaoyunque.manifest.contributes.generation.models.map((model) => model.tool)).toEqual(
      generationTools.map((tool) => tool.id),
    )
    expect(xiaoyunque.manifest.contributes.generation.models[0].name).toBe("Seedream 5.0")
    expect(xiaoyunque.manifest.contributes.generation.models.find((model) => model.tool.startsWith("video."))?.name)
      .toBe("Seedance 2.0 Mini Lite")
    expect(generationTools.map((tool) => tool.id)).toEqual([
      "image.seedream_5.0",
      "image.seedream_5.0_pro",
      "video.seedance_2.0_mini_lite",
      "video.seedance2.0_direct",
      "video.seedance2.0_vision",
      "video.seedance_2.0_mini",
    ])
    for (const tool of generationTools) {
      expect(tool.acceptedInputs).toEqual(tool.output === "image"
        ? ["reference_image"]
        : ["reference_image", "reference_video", "first_frame", "last_frame", "audio"])
    }
    expect(xiaoyunque.metadata.companions).toEqual([{
      command: "convax-xiaoyunque-mcp",
      version: "0.3.1",
      source: "packages/tools/xiaoyunque-mcp",
      targets: [{
        platform: "darwin",
        arch: "arm64",
        path: "dist/darwin-arm64/convax-xiaoyunque-mcp",
      }],
    }])
    expect(xiaoyunque.manifest).not.toHaveProperty("entry")
    expect(ffmpeg.manifest).toEqual(expect.objectContaining({
      runtime: { command: "convax-ffmpeg-mcp", type: "mcp-stdio" },
      schema: "convax.plugin/4",
    }))
    expect(ffmpeg.manifest.contributes.generation.tools.map((tool) => [tool.id, tool.output])).toEqual([
      ["run.image", "image"],
      ["run.video", "video"],
      ["run.audio", "audio"],
      ["frame.extract", "image"],
      ["video.trim", "video"],
      ["video.crop", "video"],
      ["video.without-audio", "video"],
      ["audio.extract", "audio"],
    ])
    expect(ffmpeg.manifest.contributes.generation.models).toEqual([])
    for (const tool of ffmpeg.manifest.contributes.generation.tools.slice(0, 3)) {
      expect(tool.acceptedInputs).toEqual([
        "reference_image",
        "reference_video",
        "first_frame",
        "last_frame",
        "audio",
      ])
    }
    for (const tool of ffmpeg.manifest.contributes.generation.tools.slice(3)) {
      expect(tool.acceptedInputs).toEqual(["reference_video"])
    }
    expect(ffmpeg.manifest.contributes.agent.tools).toEqual([
      { id: "run_image", tool: "run.image" },
      { id: "run_video", tool: "run.video" },
      { id: "run_audio", tool: "run.audio" },
    ])
    expect(ffmpeg.manifest.contributes.canvas.selectionActions.map((action) => [
      action.id,
      action.editor,
      action.steps.map((step) => step.tool),
    ])).toEqual([
      ["extract-frame", "time-point", ["frame.extract"]],
      ["trim", "time-range", ["video.trim"]],
      ["separate-audio-video", "confirmation", ["video.without-audio", "audio.extract"]],
      ["crop", "crop-region", ["video.crop"]],
    ])
    expect(ffmpeg.manifest.contributes.skills).toEqual([
      { name: "ffmpeg-canvas", path: "skills/ffmpeg-canvas" },
    ])
    expect(ffmpegSkill.metadata.ownerPluginId).toBe("ffmpeg-tools")
    for (const source of ffmpegSkill.files) {
      const embedded = ffmpeg.files.find((file) => file.relativePath === `skills/ffmpeg-canvas/${source.relativePath}`)
      expect(embedded?.data).toEqual(source.data)
      expect(embedded?.absolutePath).toBe(source.absolutePath)
    }
    expect(ffmpeg.metadata.companions).toEqual([{
      command: "convax-ffmpeg-mcp",
      version: "0.2.0",
      source: "packages/tools/ffmpeg-mcp",
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
      "convax-companion-convax-xiaoyunque-mcp-0.3.1-darwin-arm64",
    ])
    expect(xiaoyunque.tag).toBe("plugin-xiaoyunque-generation-v0.3.3")
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
      "convax-companion-convax-ffmpeg-mcp-0.2.0-darwin-arm64",
    ])
    const ffmpegLicense = readStoredZip(ffmpeg.zip).find((entry) => entry.relativePath === "FFMPEG-LICENSE")
    expect(ffmpegLicense?.data).toEqual(await fs.readFile(path.join(root, "packages", "tools", "ffmpeg-mcp", "FFMPEG-LICENSE")))
  })

  test("rechecks combined owned-Skill size and canonical path collisions", async () => {
    const packages = await discoverPackages()
    const ffmpeg = packages.find((pkg) => pkg.metadata.id === "ffmpeg-tools")
    const ffmpegSkill = packages.find((pkg) => pkg.metadata.kind === "skill" && pkg.metadata.id === "ffmpeg-canvas")
    const ownerBytes = ffmpeg.files
      .filter((file) => !file.relativePath.startsWith("skills/ffmpeg-canvas/"))
      .reduce((total, file) => total + file.data.byteLength, 0)
    const oversizedPackages = packages.map((pkg) =>
      pkg === ffmpeg
        ? { ...pkg, files: pkg.files.filter((file) => !file.relativePath.startsWith("skills/ffmpeg-canvas/")) }
        : pkg === ffmpegSkill
          ? {
              ...pkg,
              files: [
                ...pkg.files,
                {
                  absolutePath: "/synthetic/large.bin",
                  data: Buffer.alloc(maxPackageBytes - ownerBytes),
                  mode: 0o644,
                  relativePath: "references/large.bin",
                },
              ],
            }
          : pkg)
    expect(() => composeOwnedSkillPackages(oversizedPackages)).toThrow("package exceeds 10 MiB")

    const collisionPackages = packages.map((pkg) =>
      pkg === ffmpeg
        ? {
            ...pkg,
            files: [
              ...pkg.files.filter((file) => !file.relativePath.startsWith("skills/ffmpeg-canvas/")),
              {
                absolutePath: "/synthetic/cafe-nfd.md",
                data: Buffer.from("owner"),
                mode: 0o644,
                relativePath: "skills/ffmpeg-canvas/references/cafe\u0301.md",
              },
            ],
          }
        : pkg === ffmpegSkill
          ? {
              ...pkg,
              files: [
                ...pkg.files,
                {
                  absolutePath: "/synthetic/cafe-nfc.md",
                  data: Buffer.from("skill"),
                  mode: 0o644,
                  relativePath: "references/caf\u00e9.md",
                },
              ],
            }
          : pkg)
    expect(() => composeOwnedSkillPackages(collisionPackages)).toThrow("owned Skill path collides")

    const entryBoundPackages = packages.map((pkg) =>
      pkg === ffmpeg
        ? {
            ...pkg,
            files: [
              ...pkg.files.filter((file) => !file.relativePath.startsWith("skills/ffmpeg-canvas/")),
              ...Array.from({ length: 1_500 }, (_, index) => ({
                absolutePath: `/synthetic/plugin-${index}.txt`,
                data: Buffer.from("p"),
                mode: 0o644,
                relativePath: `fixtures/plugin-${index}.txt`,
              })),
            ],
          }
        : pkg === ffmpegSkill
          ? {
              ...pkg,
              files: [
                ...pkg.files,
                ...Array.from({ length: 500 }, (_, index) => ({
                  absolutePath: `/synthetic/skill-${index}.txt`,
                  data: Buffer.from("s"),
                  mode: 0o644,
                  relativePath: `references/skill-${index}.txt`,
                })),
              ],
            }
          : pkg)
    expect(maxPluginEntries).toBe(2_000)
    expect(() => composeOwnedSkillPackages(entryBoundPackages)).toThrow("package exceeds the 2000 entry limit")
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
    const ffmpegSkillEntry = registry.packages.find((item) => item.kind === "skill" && item.id === "ffmpeg-canvas")
    expect(helloEntry.version).toBe("0.2.0")
    expect(helloEntry.artifact.url).toContain("/plugin-hello-convax-v0.2.0/")
    expect(xiaoyunqueEntry.manifest.schema).toBe("convax.plugin/3")
    expect(xiaoyunqueEntry.companions[0].targets[0].artifact.url).toContain(
      "/convax-companion-convax-xiaoyunque-mcp-0.3.1-darwin-arm64",
    )
    expect(firstSkill).not.toHaveProperty("manifest")
    expect(ffmpegSkillEntry.ownerPluginId).toBe("ffmpeg-tools")

    const missingOwner = structuredClone(registry)
    delete missingOwner.packages
      .find((item) => item.kind === "skill" && item.id === "ffmpeg-canvas")
      .ownerPluginId
    expect(() => parseRegistry(missingOwner)).toThrow(
      "Plugin ffmpeg-tools owned Skill ffmpeg-canvas does not match a Skill ownerPluginId",
    )

    const missingSkill = structuredClone(registry)
    missingSkill.packages = missingSkill.packages
      .filter((item) => item.kind !== "skill" || item.id !== "ffmpeg-canvas")
    expect(() => parseRegistry(missingSkill)).toThrow(
      "Plugin ffmpeg-tools owned Skill ffmpeg-canvas does not match a Skill ownerPluginId",
    )
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

    const hello = packages.find((pkg) => pkg.metadata.id === "hello-convax")
    const changedHello = {
      ...hello,
      files: hello.files.map((file) =>
        file.relativePath === "manifest.json"
          ? { ...file, data: Buffer.concat([file.data, Buffer.from("\n")]) }
          : file),
    }
    await expect(
      checkReleaseCoverage({ entriesDirectory: directory, packages: [changedHello] }),
    ).rejects.toThrow("Release artifact does not match the current source package")

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
