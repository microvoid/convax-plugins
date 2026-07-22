import { describe, expect, test } from "bun:test"

import { parsePluginManifest, parseSourceMetadata } from "./lib.mjs"

function petManifest(overrides = {}) {
  return {
    schema: "convax.plugin/5",
    id: "convax-pet",
    name: "Convax Pet",
    description: "Adds Violet as a local desktop companion.",
    version: "0.1.0",
    capabilities: [],
    contributes: {
      pet: {
        name: "Violet",
        description: "A pixel companion for Convax.",
        spritesheet: "assets/violet.webp",
        spriteVersion: 2,
        alt: "Violet, the Convax pixel companion",
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
  test("parses an inert pet as a real Plugin capability", () => {
    const parsed = parsePluginManifest(petManifest())

    expect(parsed.schema).toBe("convax.plugin/5")
    expect(parsed.contributes.pet).toEqual({
      alt: "Violet, the Convax pixel companion",
      description: "A pixel companion for Convax.",
      name: "Violet",
      spritesheet: "assets/violet.webp",
      spriteVersion: 2,
    })
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
    ["remote URL", { spritesheet: "https://example.invalid/pet.webp" }],
    ["traversal", { spritesheet: "../pet.webp" }],
    ["wrong extension", { spritesheet: "assets/violet.gif" }],
    ["unknown field", { mood: "happy" }],
    ["unsupported sprite version", { spriteVersion: 3 }],
  ])("rejects a pet with %s", (_label, override) => {
    const manifest = petManifest()
    manifest.contributes.pet = { ...manifest.contributes.pet, ...override }
    expect(() => parsePluginManifest(manifest)).toThrow()
  })

  test("does not make pet available to legacy manifest schemas", () => {
    expect(() => parsePluginManifest({ ...petManifest(), schema: "convax.plugin/4" })).toThrow("unsupported field pet")
  })
})
