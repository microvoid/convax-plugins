import { describe, expect, test } from "bun:test"

import { parsePluginManifest, parseSourceMetadata, validatePetPackageLibrary } from "./lib.mjs"

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

function petLibrary(pets = [{
  id: "violet",
  displayName: "Violet",
  description: "A pixel companion for Convax.",
  spritesheet: "assets/violet.webp",
  spriteVersion: 2,
  alt: "Violet, the Convax pixel companion",
}]) {
  return { schema: "convax.pet-library/1", pets }
}

function packageFile(relativePath, data) {
  return { relativePath, data: Buffer.isBuffer(data) ? data : Buffer.from(data) }
}

function petSurfaceFiles() {
  return [packageFile("pet/index.html", "<!doctype html>"), packageFile("settings/index.html", "<!doctype html>")]
}

function petManifest(overrides = {}) {
  return {
    schema: "convax.plugin/5",
    id: "convax-pet",
    name: "Convax Pet",
    description: "A local desktop companion and pet library.",
    version: "0.2.0",
    capabilities: [
      "pet.activity.read",
      "pet.activity.open",
      "pet.preferences.write",
      "pet.custom.manage",
    ],
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
    expect(parsed.capabilities).toEqual([
      "pet.activity.read",
      "pet.activity.open",
      "pet.preferences.write",
      "pet.custom.manage",
    ])
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

  test("keeps endpoints, credentials, and headers out of LLM manifests", () => {
    for (const field of ["apiKey", "baseUrl", "headers"]) {
      expect(() =>
        parsePluginManifest(
          llmManifest({
            contributes: { llm: { ...llmManifest().contributes.llm, [field]: "private" } },
          }),
        ),
      ).toThrow("unsupported field")
    }
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
        capabilities: [...petManifest().capabilities, "projects.read"],
      }),
    ).toThrow("pet capabilities")
    expect(() =>
      parsePluginManifest({
        ...petManifest(),
        contributes: { ...petManifest().contributes, llm: llmManifest().contributes.llm },
        runtime: { command: "pet-runtime", type: "mcp-stdio" },
      }),
    ).toThrow("pet feature")
  })

  test("keeps historical Pet manifests valid when custom management is absent", () => {
    const historical = petManifest({
      version: "0.2.1",
      capabilities: petManifest().capabilities.filter((capability) => capability !== "pet.custom.manage"),
    })

    expect(parsePluginManifest(historical).capabilities).toEqual([
      "pet.activity.read",
      "pet.activity.open",
      "pet.preferences.write",
    ])
  })

  test("validates every packaged pet library atlas", () => {
    const manifest = parsePluginManifest(petManifest())
    const comet = {
      ...petLibrary().pets[0],
      id: "comet",
      displayName: "Comet",
      spritesheet: "assets/comet.png",
    }
    const library = petLibrary([...petLibrary().pets, comet])
    const files = [
      ...petSurfaceFiles(),
      packageFile("pet-library.json", JSON.stringify(library)),
      packageFile("assets/violet.webp", webp(1536, 1872)),
      packageFile("assets/comet.png", png(1536, 1872)),
    ]

    expect(validatePetPackageLibrary(manifest, files, "pet test")).toEqual(library)
  })

  test.each([
    ["missing library", petSurfaceFiles()],
    ["invalid JSON", [...petSurfaceFiles(), packageFile("pet-library.json", "{")]],
    ["empty library", [...petSurfaceFiles(), packageFile("pet-library.json", JSON.stringify(petLibrary([])))]],
    [
      "duplicate id",
      [
        ...petSurfaceFiles(),
        packageFile("pet-library.json", JSON.stringify(petLibrary([...petLibrary().pets, petLibrary().pets[0]]))),
      ],
    ],
    [
      "case-colliding atlas paths",
      [
        ...petSurfaceFiles(),
        packageFile(
          "pet-library.json",
          JSON.stringify(
            petLibrary([
              ...petLibrary().pets,
              { ...petLibrary().pets[0], id: "comet", spritesheet: "assets/VIOLET.WEBP" },
            ]),
          ),
        ),
        packageFile("assets/violet.webp", webp(1536, 1872)),
        packageFile("assets/VIOLET.WEBP", webp(1536, 1872)),
      ],
    ],
    [
      "missing atlas",
      [...petSurfaceFiles(), packageFile("pet-library.json", JSON.stringify(petLibrary()))],
    ],
    [
      "forged atlas",
      [
        ...petSurfaceFiles(),
        packageFile("pet-library.json", JSON.stringify(petLibrary())),
        packageFile("assets/violet.webp", "not an image"),
      ],
    ],
    [
      "wrong dimensions",
      [
        ...petSurfaceFiles(),
        packageFile("pet-library.json", JSON.stringify(petLibrary())),
        packageFile("assets/violet.webp", webp(1, 1)),
      ],
    ],
  ])("rejects a pet package with %s", (_label, files) => {
    expect(() => validatePetPackageLibrary(parsePluginManifest(petManifest()), files, "pet test")).toThrow()
  })
})
