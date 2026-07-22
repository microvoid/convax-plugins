import { describe, expect, test } from "bun:test"

import { parsePluginManifest, parseSourceMetadata } from "./lib.mjs"

function webp(width, height) {
  const data = Buffer.alloc(30)
  data.write("RIFF", 0)
  data.write("WEBP", 8)
  data.write("VP8X", 12)
  data.writeUIntLE(width - 1, 24, 3)
  data.writeUIntLE(height - 1, 27, 3)
  return data
}

function png(width, height) {
  const data = Buffer.alloc(24)
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(data)
  data.write("IHDR", 12)
  data.writeUInt32BE(width, 16)
  data.writeUInt32BE(height, 20)
  return data
}

function petManifest(overrides = {}) {
  return {
    schema: "convax.plugin/5",
    id: "convax-pet",
    name: "Convax Pet",
    description: "A local desktop companion and pet library.",
    version: "0.2.0",
    capabilities: ["pet.activity.read", "pet.activity.open", "pet.preferences.write"],
    contributes: {
      pet: {
        library: "pet-library.json",
        overlay: "pet/index.html",
        settings: "settings/index.html",
        protocol: "convax.pet-host/1",
      },
    },
    ...overrides,
  }
}

function projectManifest(overrides = {}) {
  return {
    schema: "convax.plugin/5",
    id: "canvas-automation",
    name: "Canvas Automation",
    description: "Automates bound Project Canvases.",
    version: "1.0.0",
    capabilities: [
      "projects.read",
      "canvas.catalog.read",
      "canvas.document.read",
      "canvas.document.write",
      "canvas.events.subscribe",
    ],
    contributes: {},
    ...overrides,
  }
}

function llmManifest(overrides = {}) {
  return {
    schema: "convax.plugin/5",
    id: "example-llm",
    name: "Example LLM",
    description: "Provides an external LLM provider.",
    version: "1.0.0",
    capabilities: [],
    contributes: {
      llm: {
        models: [{ id: "example-main", name: "Example Main" }],
        provider: { id: "example", name: "Example" },
      },
    },
    runtime: { command: "example-llm-mcp", type: "mcp-stdio" },
    ...overrides,
  }
}

describe("convax.plugin/5 transport-neutral and pet contributions", () => {
  test("parses a sandboxed pet feature as a real Plugin capability", () => {
    const parsed = parsePluginManifest(petManifest())

    expect(parsed.schema).toBe("convax.plugin/5")
    expect(parsed.contributes.pet).toEqual({
      library: "pet-library.json",
      overlay: "pet/index.html",
      protocol: "convax.pet-host/1",
      settings: "settings/index.html",
    })
    expect(parsed.capabilities).toEqual(["pet.activity.read", "pet.activity.open", "pet.preferences.write"])
    expect(parsed).not.toHaveProperty("entry")
    expect(parsed).not.toHaveProperty("runtime")
  })

  test("retains the existing v5 Project, Canvas, and LLM declarations", () => {
    expect(parsePluginManifest(projectManifest())).toMatchObject({
      capabilities: projectManifest().capabilities,
      contributes: {},
      schema: "convax.plugin/5",
    })
    expect(parsePluginManifest(llmManifest()).contributes.llm).toEqual({
      models: [{ id: "example-main", name: "Example Main" }],
      provider: { id: "example", name: "Example" },
    })
  })

  test("accepts only the transport-neutral v5 compatibility pair", () => {
    const metadata = {
      schema: "convax.package/1",
      kind: "plugin",
      id: "convax-pet",
      name: "Convax Pet",
      description: "Adds Violet as a local desktop companion.",
      version: "0.1.0",
      license: "MIT",
      compatibility: {
        pluginSchema: "convax.plugin/5",
        pluginHost: "convax.plugin-capability/1",
      },
      yanked: false,
    }

    expect(parseSourceMetadata(metadata).compatibility).toEqual(metadata.compatibility)
    expect(() =>
      parseSourceMetadata({
        ...metadata,
        compatibility: { pluginSchema: "convax.plugin/5", pluginHost: "convax.plugin-host/5" },
      }),
    ).toThrow("matching")
  })

  test.each([
    ["remote URL", { overlay: "https://example.invalid/pet.html" }],
    ["traversal", { settings: "../settings.html" }],
    ["wrong library extension", { library: "pet-library.js" }],
    ["wrong overlay extension", { overlay: "pet/app.js" }],
    ["wrong settings extension", { settings: "settings/app.js" }],
    ["unsupported protocol", { protocol: "convax.pet-host/2" }],
    ["unknown field", { mood: "happy" }],
  ])("rejects a pet with %s", (_label, override) => {
    const manifest = petManifest()
    manifest.contributes.pet = { ...manifest.contributes.pet, ...override }
    expect(() => parsePluginManifest(manifest)).toThrow()
  })

  test("does not make pet available to legacy manifest schemas", () => {
    expect(() => parsePluginManifest({ ...petManifest(), schema: "convax.plugin/4" })).toThrow("unsupported field pet")
  })

  test("requires the exact pet capabilities and forbids executable runtimes", () => {
    expect(() => parsePluginManifest({ ...petManifest(), capabilities: [] })).toThrow("pet capabilities")
    expect(() =>
      parsePluginManifest({
        ...petManifest(),
        contributes: { ...petManifest().contributes, llm: llmManifest().contributes.llm },
        runtime: { command: "pet-runtime", type: "mcp-stdio" },
      }),
    ).toThrow("pet feature")
  })
})
