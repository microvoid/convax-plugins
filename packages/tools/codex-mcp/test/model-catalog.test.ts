import { describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { codexLlmModels, codexImageToolId } from "../src/contracts.ts"
import { tools } from "../src/mcp-server.ts"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..")

describe("Codex Plugin catalog", () => {
  test("keeps manifest models and MCP tools aligned", async () => {
    const manifest = JSON.parse(await fs.readFile(
      path.join(root, "plugins/codex-service/package/manifest.json"),
      "utf8",
    )) as {
      contributes: {
        generation: { models: Array<{ name: string; tool: string }>; tools: Array<{ id: string }> }
        llm: { models: Array<{ id: string; name: string }>; provider: { id: string; name: string } }
        service: { actions: string[] }
      }
      schema: string
    }
    expect(manifest.schema).toBe("convax.plugin/5")
    expect(manifest.contributes.llm).toEqual({
      models: codexLlmModels.map((model) => ({ ...model })),
      provider: { id: "codex", name: "Codex" },
    })
    expect(manifest.contributes.generation.models).toEqual([{ name: "GPT Image 2", tool: codexImageToolId }])
    expect(manifest.contributes.generation.tools.map((tool) => tool.id)).toEqual([codexImageToolId])
    expect(manifest.contributes.service.actions).toEqual(["authorize", "reauthorize"])
    expect(tools.map((tool) => tool.name)).toEqual([
      codexImageToolId,
      "service.status",
      "service.authorize",
      "service.reauthorize",
      "llm.gateway.start",
    ])
  })
})
