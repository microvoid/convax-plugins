import { describe, expect, test } from "bun:test"
import { promises as fs } from "node:fs"
import path from "node:path"

import {
  createDefaultState,
  createGenerationRequest,
  createMultiAngleGridPrompt,
  executeGridGeneration,
  hydratePluginState,
  normalizeGenerationResult,
  normalizeGenerationTools,
} from "../packages/plugins/multi-angle/package/assets/multi-angle-model.js"
import { root } from "./lib.mjs"

const sourceRoot = path.join(root, "packages", "plugins", "multi-angle")
const packageRoot = path.join(sourceRoot, "package")

async function read(relativePath) {
  return fs.readFile(path.join(packageRoot, ...relativePath.split("/")), "utf8")
}

async function relativeFiles(directory, prefix = "") {
  const files = []
  for (const entry of await fs.readdir(path.join(directory, prefix), { withFileTypes: true })) {
    const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name
    if (entry.isDirectory()) files.push(...await relativeFiles(directory, relativePath))
    else files.push(relativePath)
  }
  return files.sort()
}

describe("multi-angle Plugin package", () => {
  test("is a provider-neutral v3 Web Plugin that uses only the unified generation API", async () => {
    const metadata = JSON.parse(await fs.readFile(path.join(sourceRoot, "convax-package.json"), "utf8"))
    const manifest = JSON.parse(await read("manifest.json"))
    expect(manifest).toMatchObject({
      capabilities: ["canvas.connectedImages.read", "canvas.node.write", "generation.execute"],
      contributes: { canvas: { renderer: { create: true, height: 720, width: 1080 } } },
      entry: "index.html",
      id: "multi-angle",
      schema: "convax.plugin/3",
      version: "0.1.0",
    })
    expect(metadata.compatibility).toEqual({
      pluginHost: "convax.plugin-host/3",
      pluginSchema: "convax.plugin/3",
    })
    expect(manifest).not.toHaveProperty("runtime")
    expect(manifest.contributes).not.toHaveProperty("generation")
    expect(manifest).not.toHaveProperty("skill")
    expect(metadata).not.toHaveProperty("companions")
    expect(await relativeFiles(packageRoot)).toEqual([
      "LICENSE",
      "assets/app.js",
      "assets/multi-angle-model.js",
      "assets/styles.css",
      "index.html",
      "manifest.json",
    ])

    const entry = await read("index.html")
    const app = await read("assets/app.js")
    const model = await read("assets/multi-angle-model.js")
    const styles = await read("assets/styles.css")
    const runtime = `${app}\n${model}`
    expect(entry.match(/<script\b/gu)).toHaveLength(1)
    expect(entry).toContain('src="./assets/app.js"')
    expect(entry).toContain('href="./assets/styles.css"')
    expect(entry).not.toMatch(/(?:src|href)=["'](?:https?:|\/\/|\/)/u)
    expect(styles).not.toContain("@import")
    expect(styles).not.toContain("url(")
    expect(app).toContain('HOST_PROTOCOL = "convax.plugin-host/3"')
    expect(app).toContain('hostRequest("generation.tools.list", { output: "image" })')
    expect(app).toContain('hostRequest("generation.canvas.execute", request, null)')
    expect(app).toContain("stateWritesSuspended = true")
    expect(app.indexOf("stateWritesSuspended = true")).toBeLessThan(app.indexOf('hostRequest("generation.canvas.execute"'))
    expect(runtime).not.toContain("agent.prompt")
    expect(runtime).not.toContain("CONVAX_MULTI_ANGLE_RESULT")
    expect(runtime).not.toContain("canvas_add_resources")
    expect(runtime).not.toContain("baselineNodeIds")
    expect(runtime).not.toContain("executeAngleSequence")
    expect(runtime).not.toContain("activePresetId")
    expect(runtime).not.toContain("partial")
    expect(runtime).not.toContain("顺序发起")
    expect(runtime).not.toContain("Promise.all")
    expect(runtime).not.toContain("localStorage")
    expect(runtime).not.toContain("sessionStorage")
    expect(runtime).not.toContain("indexedDB")
    expect(runtime).not.toContain("XMLHttpRequest")
    expect(runtime).not.toContain("WebSocket")
    expect(runtime).not.toMatch(/\bfetch\s*\(/u)
    expect(runtime).not.toMatch(/https?:\/\//u)
  })

  test("discovers only reference-image AI models and never guesses from provider titles", () => {
    const tools = normalizeGenerationTools({
      tools: [
        {
          acceptedInputs: ["reference_image"],
          description: "AI image model",
          id: "provider/image.model",
          kind: "model",
          output: "image",
          title: "Provider · Image Model",
        },
        {
          acceptedInputs: ["reference_image"],
          description: "FFmpeg operation",
          id: "ffmpeg-tools/run.image",
          kind: "operation",
          output: "image",
          title: "Run image operation",
        },
        {
          acceptedInputs: ["text"],
          description: "Text-to-image only",
          id: "provider/text-image",
          kind: "model",
          output: "image",
          title: "Provider · Text Image",
        },
        {
          acceptedInputs: ["reference_image"],
          description: "Missing model metadata",
          id: "provider/unknown",
          output: "image",
          title: "Looks like a model but is not classified",
        },
      ],
    })
    expect(tools.map((tool) => tool.id)).toEqual(["provider/image.model"])
    expect(tools[0]).toMatchObject({ kind: "model", output: "image", title: "Provider · Image Model" })
  })

  test("builds one multi-angle grid prompt and one exact direct-incoming generation request", () => {
    const presetIds = ["front", "left", "top", "cinematic"]
    const prompt = createMultiAngleGridPrompt({
      notes: "keep the red coat and soft side light",
      presetIds,
      subjectType: "character",
    })
    expect(prompt).toContain("标准白底角色设定图")
    expect(prompt).toContain("最终只输出一张图片")
    expect(prompt).toContain("2 行 × 2 列的4宫格")
    expect(prompt).toContain("eye-level front view")
    expect(prompt).toContain("true left profile view")
    expect(prompt).toContain("high top-down view")
    expect(prompt).toContain("cinematic three-quarter view")
    expect(prompt).toContain("每个格子只展示同一主体的一个视角")
    expect(prompt).toContain("所有格子中的主体必须完全一致")
    expect(prompt).toContain("不要把视角拆成多张图片")
    expect(prompt).not.toContain("Do not create a contact sheet, grid, collage")
    expect(prompt).toContain("keep the red coat and soft side light")
    expect(createGenerationRequest({
      prompt,
      sourceNodeId: "source-1",
      toolId: "provider/image.model",
    })).toEqual({
      output: "image",
      prompt,
      references: [{ nodeId: "source-1", role: "reference_image" }],
      resultMode: "create-pending-node",
      toolId: "provider/image.model",
    })
    expect(() => createMultiAngleGridPrompt({
      notes: "",
      presetIds: ["front"],
      subjectType: "character",
    })).toThrow("镜头方案无效")
  })

  test("executes the whole grid through exactly one generation call", async () => {
    let successCalls = 0
    const complete = await executeGridGeneration({
      execute: async () => {
        successCalls += 1
        return { createdNodeIds: ["node-grid"] }
      },
    })
    expect(successCalls).toBe(1)
    expect(complete).toEqual({
      failure: null,
      result: { createdNodeIds: ["node-grid"] },
    })

    let failureCalls = 0
    const failed = await executeGridGeneration({
      execute: async () => {
        failureCalls += 1
        throw new Error("Canvas generation could not be completed")
      },
    })
    expect(failureCalls).toBe(1)
    expect(failed).toEqual({
      failure: { message: "Canvas generation could not be completed" },
      result: null,
    })
  })

  test("preserves the authoritative grid node ids and migrates only portable legacy planning state", () => {
    const result = normalizeGenerationResult({
      createdNodeIds: ["node-front-a", "node-front-b"],
      revision: 8,
      toolId: "provider/image.model",
      warnings: ["one warning"],
    }, ["front", "left", "top"], "2026-07-21T00:00:01.000Z")
    expect(result.createdNodeIds).toEqual(["node-front-a", "node-front-b"])
    expect(result.presetIds).toEqual(["front", "left", "top"])
    expect(result.revision).toBe(8)

    const legacy = hydratePluginState({
      lastRun: { status: "waiting" },
      notes: "keep materials",
      results: [{ nodeId: "old-agent-result", presetId: "front" }],
      schemaVersion: 2,
      selectedPresetIds: ["front", "top", "front"],
      sourceNodeId: "source-1",
      subjectType: "product",
      toolId: "provider/image.model",
    })
    expect(legacy.source).toBe("legacy")
    expect(legacy.state).toMatchObject({
      lastRun: null,
      notes: "keep materials",
      result: null,
      schemaVersion: 3,
      selectedPresetIds: ["front", "top"],
      sourceNodeId: "source-1",
      subjectType: "product",
      toolId: "provider/image.model",
    })

    const interrupted = hydratePluginState({
      ...createDefaultState(),
      lastRun: {
        completedAt: "",
        failure: null,
        presetIds: ["front", "top"],
        sourceNodeId: "source-1",
        startedAt: "2026-07-21T00:00:00.000Z",
        status: "running",
        toolId: "provider/image.model",
      },
      result,
      sourceNodeId: "source-1",
      toolId: "provider/image.model",
    })
    expect(interrupted.source).toBe("current")
    expect(interrupted.state.result.createdNodeIds).toEqual(["node-front-a", "node-front-b"])
    expect(interrupted.state.lastRun).toMatchObject({
      failure: { message: expect.any(String) },
      status: "interrupted",
    })

    const unsupported = hydratePluginState({ schemaVersion: 99, providerSecret: "must remain untouched" })
    expect(unsupported.source).toBe("unsupported")
    expect(unsupported.state).toEqual(createDefaultState())
  })
})
