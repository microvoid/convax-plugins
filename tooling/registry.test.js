import { afterAll, describe, expect, test } from "bun:test"
import { promises as fs } from "node:fs"
import os from "node:os"
import path from "node:path"
import vm from "node:vm"
import { buildIndex } from "./build-index.mjs"
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
  test("validates the Plugin and Skill examples", async () => {
    const packages = await discoverPackages()
    expect(packages.map((pkg) => `${pkg.metadata.kind}/${pkg.metadata.id}`)).toEqual([
      "plugin/hello-convax",
      "skill/hello-convax-guide",
    ])
    expect(packages[0].manifest.schema).toBe("convax.plugin/1")
    expect(packages[0].manifest.capabilities).toEqual([])
  })

  test("creates byte-identical ZIPs with required root entries", async () => {
    const packages = await discoverPackages()
    const first = await packPackages(packages, path.join(await temporaryDirectory(), "first"))
    const second = await packPackages(packages, path.join(await temporaryDirectory(), "second"))
    expect(first.map((item) => sha256(item.zip))).toEqual(second.map((item) => sha256(item.zip)))
    expect(readStoredZip(first[0].zip).map((entry) => entry.relativePath)).toContain("manifest.json")
    expect(readStoredZip(first[1].zip).map((entry) => entry.relativePath)).toContain("SKILL.md")
  })

  test("builds the strict client Registry with only the latest stable version", async () => {
    const packages = await discoverPackages()
    const directory = await temporaryDirectory()
    const packed = path.join(directory, "packages")
    const output = path.join(directory, "registry", "v1", "index.json")
    const packedResults = await packPackages(packages, packed)
    const newer = structuredClone(packedResults[0].entry)
    newer.version = "0.2.0"
    newer.manifest.version = "0.2.0"
    newer.artifact.url = newer.artifact.url.replaceAll("0.1.0", "0.2.0")
    const newerDirectory = path.join(packed, "plugin-hello-convax-v0.2.0")
    await fs.mkdir(newerDirectory)
    await fs.writeFile(path.join(newerDirectory, "registry-entry.json"), `${JSON.stringify(newer, null, 2)}\n`)
    const registry = await buildIndex({ entriesDirectory: packed, outputFile: output, revision: "a".repeat(40), sequence: 7 })
    expect(parseRegistry(JSON.parse(await fs.readFile(output, "utf8")))).toEqual(registry)
    expect(Object.keys(registry)).toEqual(["schema", "sequence", "revision", "packages"])
    expect(registry.packages[0].manifest.id).toBe("hello-convax")
    expect(registry.packages[0].version).toBe("0.2.0")
    expect(registry.packages[0].artifact.url).toContain("/plugin-hello-convax-v0.2.0/")
    expect(registry.packages[1]).not.toHaveProperty("manifest")
  })

  test("requires a Release ZIP whose size matches its Registry entry", async () => {
    const packages = await discoverPackages()
    const directory = await temporaryDirectory()
    const [packed] = await packPackages([packages[0]], path.join(directory, "packed"))
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
