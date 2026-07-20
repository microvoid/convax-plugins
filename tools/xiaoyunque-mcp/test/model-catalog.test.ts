import { describe, expect, test } from "bun:test"
import { readFile } from "node:fs/promises"
import path from "node:path"
import { generationMcpTools, serviceMcpTools } from "../src/mcp-server.ts"
import { generationTools } from "../src/models.ts"

const expectedCatalog = [
  { model: "seedream_5.0_pro", name: "image.seedream_5.0_pro", output: "image" },
  { model: "seedream_5.0", name: "image.seedream_5.0", output: "image" },
  { model: "seedream_4.3", name: "image.seedream_4.3", output: "image" },
  { model: "seedream_4.5", name: "image.seedream_4.5", output: "image" },
  { model: "seedream_4.1", name: "image.seedream_4.1", output: "image" },
  { model: "seedream_4", name: "image.seedream_4", output: "image" },
  { model: "nano_banana_pro_1", name: "image.nano_banana_pro_1", output: "image" },
  { model: "gpt_image_2", name: "image.gpt_image_2", output: "image" },
  { model: "Seedance_2.0_mini_lite", name: "video.seedance_2.0_mini_lite", output: "video" },
  { model: "Seedance_2.0_mini", name: "video.seedance_2.0_mini", output: "video" },
  { model: "seedance2.0_fast_vision", name: "video.seedance2.0_fast_vision", output: "video" },
  { model: "seedance2.0_vision", name: "video.seedance2.0_vision", output: "video" },
  { model: "seedance2.0_fast_direct", name: "video.seedance2.0_fast_direct", output: "video" },
  { model: "seedance2.0_direct", name: "video.seedance2.0_direct", output: "video" },
  { model: "seedance1.5_direct", name: "video.seedance1.5_direct", output: "video" },
  { model: "Seedance_1.0_fast", name: "video.seedance_1.0_fast", output: "video" },
] as const

describe("XiaoYunque first-party Web model catalog", () => {
  test("uses the model values exposed by the current first-party Web client", () => {
    expect(generationTools.map(({ model, name, output }) => ({ model, name, output })))
      .toEqual([...expectedCatalog])
  })

  test("excludes web_model_config v5 entries rejected by the raw image submit surface", () => {
    // Live regression evidence: get_thread ended an accepted raw-image Nova 2
    // run with the exact terminal reason `unsupported image_model_name: nova2`.
    // A discovery catalog entry is not sufficient evidence that submit_run can
    // execute it, so this id must remain absent until a valid raw id is verified.
    expect(generationTools.map(({ model }) => model)).not.toContain("nova2")
    expect(generationTools.map(({ name }) => name)).not.toContain("image.nova2")
  })

  test("keeps Plugin manifest tool ids identical to MCP tools/list names", async () => {
    const manifestPath = path.join(
      import.meta.dir,
      "..",
      "..",
      "..",
      "packages",
      "plugins",
      "xiaoyunque-generation",
      "package",
      "manifest.json",
    )
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
      contributes: { generation: { tools: Array<{ acceptedInputs: string[]; id: string }> } }
    }
    const manifestIds = manifest.contributes.generation.tools.map((tool) => tool.id)
    expect(manifestIds).toEqual(expectedCatalog.map((tool) => tool.name))
    const mcpNames: string[] = generationMcpTools.map((tool) => tool.name)
    expect(mcpNames).toEqual(manifestIds)
    expect(manifest.contributes.generation.tools.find((tool) => tool.id === "video.seedance_1.0_fast")?.acceptedInputs)
      .toEqual(["reference_image"])
  })

  test("declares service tools separately from generation models", async () => {
    const manifestPath = path.join(
      import.meta.dir,
      "..",
      "..",
      "..",
      "packages",
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
