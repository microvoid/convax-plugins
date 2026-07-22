import { describe, expect, test } from "bun:test"
import { readFile } from "node:fs/promises"
import path from "node:path"
import { generationMcpTools, serviceMcpTools } from "../src/mcp-server.ts"
import { generationTools } from "../src/models.ts"

const expectedCatalog = [
  { model: "seedream_5.0", name: "image.seedream_5.0", output: "image" },
  { model: "seedream_5.0_pro", name: "image.seedream_5.0_pro", output: "image" },
  { model: "Seedance_2.0_mini_lite", name: "video.seedance_2.0_mini_lite", output: "video" },
  { model: "seedance2.0_direct", name: "video.seedance2.0_direct", output: "video" },
  { model: "seedance2.0_vision", name: "video.seedance2.0_vision", output: "video" },
  { model: "Seedance_2.0_mini", name: "video.seedance_2.0_mini", output: "video" },
] as const

describe("XiaoYunque governed model catalog", () => {
  test("exposes only the approved image and video models", () => {
    expect(generationTools.map(({ model, name, output }) => ({ model, name, output })))
      .toEqual([...expectedCatalog])
  })

  test("puts the requested defaults first for each output", () => {
    expect(generationTools.filter((tool) => tool.output === "image")[0]?.model).toBe("seedream_5.0")
    expect(generationTools.filter((tool) => tool.output === "video")[0]?.model).toBe("Seedance_2.0_mini_lite")
  })

  test("keeps Plugin manifest tool ids identical to MCP tools/list names", async () => {
    const manifestPath = path.join(
      import.meta.dir,
      "..",
      "..",
      "..",
      "plugins",
      "xiaoyunque-generation",
      "package",
      "manifest.json",
    )
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
      contributes: {
        generation: {
          models: Array<{ name: string; tool: string }>
          tools: Array<{ acceptedInputs: string[]; id: string }>
        }
      }
    }
    const manifestIds = manifest.contributes.generation.tools.map((tool) => tool.id)
    expect(manifestIds).toEqual(expectedCatalog.map((tool) => tool.name))
    expect(manifest.contributes.generation.models.map((model) => model.tool)).toEqual(manifestIds)
    expect(manifest.contributes.generation.models.map((model) => model.name)).toEqual([
      "Seedream 5.0",
      "Seedream 5.0 Pro",
      "Seedance 2.0 Mini Lite",
      "Seedance 2.0",
      "Seedance 2.0 Vision",
      "Seedance 2.0 Mini",
    ])
    const mcpNames: string[] = generationMcpTools.map((tool) => tool.name)
    expect(mcpNames).toEqual(manifestIds)
    for (const tool of manifest.contributes.generation.tools.filter((item) => item.id.startsWith("image."))) {
      expect(tool.acceptedInputs).toEqual(["reference_image"])
    }
    for (const tool of manifest.contributes.generation.tools.filter((item) => item.id.startsWith("video."))) {
      expect(tool.acceptedInputs).toEqual([
        "reference_image",
        "reference_video",
        "first_frame",
        "last_frame",
        "audio",
      ])
    }
  })

  test("declares service tools separately from generation models", async () => {
    const manifestPath = path.join(
      import.meta.dir,
      "..",
      "..",
      "..",
      "plugins",
      "xiaoyunque-generation",
      "package",
      "manifest.json",
    )
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
      contributes: { service: { actions: string[] } }
    }
    expect(manifest.contributes.service).toEqual({
      actions: ["authorize", "reauthorize", "authorization.cancel", "sign_out"],
    })
    expect(serviceMcpTools.map((tool) => tool.name)).toEqual([
      "service.status",
      "service.authorize",
      "service.reauthorize",
      "service.authorization.cancel",
      "service.authorization.complete",
      "service.sign_out",
    ])
    expect(generationMcpTools).toHaveLength(expectedCatalog.length)
  })
})
