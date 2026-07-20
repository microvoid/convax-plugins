import { describe, expect, test } from "bun:test"

import {
  assetNameFor,
  assertPluginStatic,
  parsePluginManifest,
  parseRegistryEntry,
  parseSourceMetadata,
  repository,
  tagFor,
} from "./lib.mjs"

function generationManifest(overrides = {}) {
  return {
    schema: "convax.plugin/2",
    id: "example-generation",
    name: "Example Generation",
    description: "Generates media through a separately installed tool.",
    version: "1.0.0",
    contributes: {
      generation: {
        tools: [{
          id: "image.generate",
          title: "Generate image",
          description: "Generate an image from a prompt.",
          output: "image",
          acceptedInputs: [],
        }],
      },
    },
    runtime: { type: "mcp-stdio", command: "example-generation-mcp" },
    ...overrides,
  }
}

function sourceMetadata(compatibility) {
  return {
    schema: "convax.package/1",
    kind: "plugin",
    id: "example-generation",
    name: "Example Generation",
    description: "Generates media through a separately installed tool.",
    version: "1.0.0",
    license: "MIT",
    compatibility,
    yanked: false,
  }
}

function serviceContribution(actions = ["sign_out"]) {
  return { actions }
}

describe("convax.plugin/2 authoring", () => {
  test("normalizes a manifest-only headless generation declaration", () => {
    const parsed = parsePluginManifest(generationManifest())

    expect(parsed).toEqual(expect.objectContaining({
      capabilities: [],
      contributes: generationManifest().contributes,
      runtime: { type: "mcp-stdio", command: "example-generation-mcp" },
      schema: "convax.plugin/2",
    }))
    expect(parsed).not.toHaveProperty("entry")
  })

  test("accepts only version-matched Plugin schema and host pairs", () => {
    expect(parseSourceMetadata(sourceMetadata({
      pluginSchema: "convax.plugin/1",
      pluginHost: "convax.plugin-host/1",
    })).compatibility).toEqual({ pluginSchema: "convax.plugin/1", pluginHost: "convax.plugin-host/1" })
    expect(parseSourceMetadata(sourceMetadata({
      pluginSchema: "convax.plugin/2",
      pluginHost: "convax.plugin-host/2",
    })).compatibility).toEqual({ pluginSchema: "convax.plugin/2", pluginHost: "convax.plugin-host/2" })

    for (const compatibility of [
      { pluginSchema: "convax.plugin/1", pluginHost: "convax.plugin-host/2" },
      { pluginSchema: "convax.plugin/2", pluginHost: "convax.plugin-host/1" },
    ]) {
      expect(() => parseSourceMetadata(sourceMetadata(compatibility))).toThrow("must pair")
    }
  })

  test("requires the external runtime and an executable contribution together", () => {
    const withoutRuntime = generationManifest()
    delete withoutRuntime.runtime
    expect(() => parsePluginManifest(withoutRuntime)).toThrow("must appear together")

    const withoutGeneration = generationManifest({ contributes: {} })
    expect(() => parsePluginManifest(withoutGeneration)).toThrow("must appear together")
  })

  test("supports service-only and shared generation/service runtimes", () => {
    const serviceOnly = parsePluginManifest(generationManifest({
      contributes: { service: serviceContribution() },
    }))
    expect(serviceOnly.contributes).toEqual({ service: { actions: ["sign_out"] } })
    expect(serviceOnly.runtime).toEqual({ type: "mcp-stdio", command: "example-generation-mcp" })

    const generation = generationManifest()
    const shared = parsePluginManifest({
      ...generation,
      contributes: {
        ...generation.contributes,
        service: serviceContribution(["reauthorize", "authorization.cancel", "sign_out"]),
      },
    })
    expect(shared.contributes.generation.tools).toHaveLength(1)
    expect(shared.contributes.service.actions).toEqual(["reauthorize", "authorization.cancel", "sign_out"])

    const statusOnly = parsePluginManifest(generationManifest({
      contributes: { service: serviceContribution([]) },
    }))
    expect(statusOnly.contributes.service.actions).toEqual([])
  })

  test("rejects unknown, duplicate, or remapped service actions", () => {
    expect(() => parsePluginManifest(generationManifest({
      contributes: { service: serviceContribution(["open_browser"]) },
    }))).toThrow("unsupported or duplicate")
    expect(() => parsePluginManifest(generationManifest({
      contributes: { service: serviceContribution(["sign_out", "sign_out"]) },
    }))).toThrow("unsupported or duplicate")
    expect(() => parsePluginManifest(generationManifest({
      contributes: { service: { actions: ["sign_out"], statusTool: "arbitrary.call" } },
    }))).toThrow("unsupported field")
  })

  test("rejects provider fields, unsafe commands, and unsupported reference roles", () => {
    expect(() => parsePluginManifest({ ...generationManifest(), provider: "vendor" })).toThrow("unsupported field")
    expect(() => parsePluginManifest(generationManifest({
      runtime: { type: "mcp-stdio", command: "../example-generation-mcp" },
    }))).toThrow("bare executable")
    const manifest = generationManifest()
    manifest.contributes.generation.tools[0].acceptedInputs = ["mask"]
    expect(() => parsePluginManifest(manifest)).toThrow("unsupported or duplicate role")
  })

  test("keeps executables and Node servers outside the Plugin ZIP", () => {
    expect(() => assertPluginStatic([
      { data: Buffer.from("binary"), mode: 0o100755, relativePath: "example-generation-mcp" },
    ], "plugin")).toThrow("executable file mode")
    expect(() => assertPluginStatic([
      { data: Buffer.from('import http from "node:http"\nhttp.createServer(() => {})'), mode: 0o100644, relativePath: "server.js" },
    ], "plugin")).toThrow("Node or executable runtime")
    expect(() => assertPluginStatic([
      { data: Buffer.from("from http.server import HTTPServer"), mode: 0o100644, relativePath: "server.py" },
    ], "plugin")).toThrow("executable or server source")
  })

  test("rejects a Registry entry whose compatibility does not match its manifest", () => {
    const metadata = parseSourceMetadata(sourceMetadata({
      pluginSchema: "convax.plugin/1",
      pluginHost: "convax.plugin-host/1",
    }))
    const entry = {
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
      manifest: generationManifest(),
    }

    expect(() => parseRegistryEntry(entry)).toThrow("compatibility must match manifest schema")
  })
})
