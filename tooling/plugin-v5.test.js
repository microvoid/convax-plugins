import { describe, expect, test } from "bun:test"
import { parsePluginManifest, parseSourceMetadata } from "./lib.mjs"

function manifest(overrides = {}) {
  return {
    capabilities: [],
    contributes: {
      llm: {
        models: [{ id: "pippit-glm-main", name: "Pippit GLM Main" }],
        provider: { id: "pippit-glm", name: "Pippit GLM" },
      },
    },
    description: "External LLM provider",
    id: "xiaoyunque-generation",
    name: "XiaoYunque",
    runtime: { command: "convax-xiaoyunque-mcp", type: "mcp-stdio" },
    schema: "convax.plugin/5",
    version: "0.4.0",
    ...overrides,
  }
}

describe("convax.plugin/5 LLM contributions", () => {
  test("parses bounded provider and model display metadata", () => {
    expect(parsePluginManifest(manifest()).contributes.llm).toEqual({
      models: [{ id: "pippit-glm-main", name: "Pippit GLM Main" }],
      provider: { id: "pippit-glm", name: "Pippit GLM" },
    })
  })

  test("keeps endpoints, credentials, and headers out of the manifest", () => {
    for (const field of ["apiKey", "baseUrl", "headers"]) {
      expect(() => parsePluginManifest(manifest({
        contributes: { llm: { ...manifest().contributes.llm, [field]: "private" } },
      }))).toThrow("unsupported field")
    }
  })

  test("requires the v5 capability compatibility broker", () => {
    const metadata = {
      companions: [{
        command: "convax-xiaoyunque-mcp",
        source: "packages/tools/xiaoyunque-mcp",
        targets: [{ arch: "arm64", path: "dist/darwin-arm64/convax-xiaoyunque-mcp", platform: "darwin" }],
        version: "0.4.0",
      }],
      compatibility: { pluginHost: "convax.plugin-capability/1", pluginSchema: "convax.plugin/5" },
      description: "External LLM provider",
      id: "xiaoyunque-generation",
      kind: "plugin",
      license: "MIT",
      name: "XiaoYunque",
      schema: "convax.package/1",
      version: "0.4.0",
      yanked: false,
    }
    expect(parseSourceMetadata(metadata).compatibility).toEqual(metadata.compatibility)
    expect(() => parseSourceMetadata({
      ...metadata,
      compatibility: { pluginHost: "convax.plugin-host/4", pluginSchema: "convax.plugin/5" },
    })).toThrow("matching")
  })
})
