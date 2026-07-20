import { afterAll, describe, expect, test } from "bun:test"
import { promises as fs } from "node:fs"
import path from "node:path"

import {
  assetNameFor,
  companionAssetNameFor,
  loadCompanionArtifacts,
  parseRegistryEntry,
  parseSourceMetadata,
  repository,
  root,
  sha256,
  tagFor,
} from "./lib.mjs"

const cleanup = []

afterAll(async () => {
  await Promise.all(cleanup.map((directory) => fs.rm(directory, { recursive: true, force: true })))
})

function sourceMetadata(companions) {
  return {
    schema: "convax.package/1",
    kind: "plugin",
    id: "example-generation",
    name: "Example Generation",
    description: "Generates media through a separately published executable.",
    version: "1.0.0",
    license: "MIT",
    compatibility: { pluginSchema: "convax.plugin/2", pluginHost: "convax.plugin-host/2" },
    companions,
    yanked: false,
  }
}

function sourceCompanion(overrides = {}) {
  return {
    command: "example-generation-mcp",
    version: "2.3.4",
    source: "tools/xiaoyunque-mcp",
    targets: [{ platform: "darwin", arch: "arm64", path: "dist/darwin-arm64/convax-xiaoyunque-mcp" }],
    ...overrides,
  }
}

function manifest() {
  return {
    schema: "convax.plugin/2",
    id: "example-generation",
    name: "Example Generation",
    description: "Generates media through a separately published executable.",
    version: "1.0.0",
    contributes: {
      generation: {
        tools: [{
          id: "image.generate",
          title: "Generate image",
          description: "Generate one image.",
          output: "image",
          acceptedInputs: [],
        }],
      },
    },
    runtime: { type: "mcp-stdio", command: "example-generation-mcp" },
  }
}

function registryEntry() {
  const metadata = parseSourceMetadata(sourceMetadata([sourceCompanion()]))
  const companion = metadata.companions[0]
  const target = companion.targets[0]
  const companionName = companionAssetNameFor(metadata, companion, target)
  return {
    kind: metadata.kind,
    id: metadata.id,
    name: metadata.name,
    description: metadata.description,
    version: metadata.version,
    compatibility: metadata.compatibility,
    artifact: {
      url: `https://github.com/${repository}/releases/download/${tagFor(metadata)}/${assetNameFor(metadata)}`,
      size: 1,
      sha256: "a".repeat(64),
    },
    yanked: false,
    manifest: manifest(),
    companions: [{
      command: companion.command,
      version: companion.version,
      targets: [{
        platform: target.platform,
        arch: target.arch,
        artifact: {
          url: `https://github.com/${repository}/releases/download/${tagFor(metadata)}/${companionName}`,
          size: 42,
          sha256: "b".repeat(64),
        },
      }],
    }],
  }
}

describe("companion executable publishing", () => {
  test("normalizes reviewed source and strict Registry target metadata", () => {
    const source = parseSourceMetadata(sourceMetadata([sourceCompanion()]))
    expect(source.companions).toEqual([sourceCompanion()])
    const entry = parseRegistryEntry(registryEntry())
    expect(entry.companions[0]).toEqual(expect.objectContaining({
      command: "example-generation-mcp",
      version: "2.3.4",
    }))
    expect(entry.companions[0].targets[0].artifact.size).toBe(42)
  })

  test("rejects unsafe source paths, unsupported targets, and duplicate targets", () => {
    expect(() => parseSourceMetadata(sourceMetadata([sourceCompanion({ source: "../tools/sidecar" })])))
      .toThrow("traversal segments")
    expect(() => parseSourceMetadata(sourceMetadata([sourceCompanion({
      targets: [{ platform: "freebsd", arch: "arm64", path: "dist/tool" }],
    })]))).toThrow("unsupported platform")
    expect(() => parseSourceMetadata(sourceMetadata([sourceCompanion({
      targets: [
        { platform: "darwin", arch: "arm64", path: "dist/a" },
        { platform: "darwin", arch: "arm64", path: "dist/b" },
      ],
    })]))).toThrow("duplicate platform/architecture target")
  })

  test("rejects duplicate Registry targets, mismatched commands, URLs, sizes, and digests", () => {
    const duplicate = registryEntry()
    duplicate.companions[0].targets.push(structuredClone(duplicate.companions[0].targets[0]))
    expect(() => parseRegistryEntry(duplicate)).toThrow("duplicate platform/architecture target")

    const command = registryEntry()
    command.companions[0].command = "another-command"
    command.companions[0].targets[0].artifact.url = command.companions[0].targets[0].artifact.url
      .replace("example-generation-mcp", "another-command")
    expect(() => parseRegistryEntry(command)).toThrow("declared external runtime command")

    const url = registryEntry()
    url.companions[0].targets[0].artifact.url = "https://example.com/tool"
    expect(() => parseRegistryEntry(url)).toThrow("url must equal")

    const size = registryEntry()
    size.companions[0].targets[0].artifact.size = 128 * 1024 * 1024 + 1
    expect(() => parseRegistryEntry(size)).toThrow("invalid size")

    const digest = registryEntry()
    digest.companions[0].targets[0].artifact.sha256 = "B".repeat(64)
    expect(() => parseRegistryEntry(digest)).toThrow("invalid sha256")
  })

  test("reads the release build as bytes and rejects a symlinked artifact", async () => {
    const metadata = parseSourceMetadata(sourceMetadata([sourceCompanion()]))
    const [built] = await loadCompanionArtifacts({ metadata })
    expect(built.targets[0].data.length).toBe(built.targets[0].artifact.size)
    expect(sha256(built.targets[0].data)).toBe(built.targets[0].artifact.sha256)

    const directory = await fs.mkdtemp(path.join(root, "tools/xiaoyunque-mcp/dist/companion-symlink-test-"))
    cleanup.push(directory)
    await fs.symlink(
      path.join(root, "tools/xiaoyunque-mcp/dist/darwin-arm64/convax-xiaoyunque-mcp"),
      path.join(directory, "tool"),
    )
    const relative = path.relative(path.join(root, "tools/xiaoyunque-mcp"), path.join(directory, "tool"))
      .split(path.sep).join("/")
    const symlinked = parseSourceMetadata(sourceMetadata([sourceCompanion({
      targets: [{ platform: "darwin", arch: "arm64", path: relative }],
    })]))
    await expect(loadCompanionArtifacts({ metadata: symlinked })).rejects.toThrow("symlink is forbidden")
  })
})
