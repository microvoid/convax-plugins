import { describe, expect, test } from "bun:test"
import { promises as fs } from "node:fs"
import path from "node:path"

import {
  buildRelightGenerationRequest,
  normalizeGenerationTools,
} from "../packages/plugins/relight-studio/package/assets/generation.js"
import {
  assertPluginStatic,
  collectFiles,
  parsePluginManifest,
  parseSourceMetadata,
  readJson,
  root,
} from "./lib.mjs"

const sourceRoot = path.join(root, "packages", "plugins", "relight-studio")
const packageRoot = path.join(sourceRoot, "package")

describe("relight-studio package", () => {
  test("declares a v3 Web caller of the shared generation executor", async () => {
    const metadata = parseSourceMetadata(
      await readJson(path.join(sourceRoot, "convax-package.json")),
      "plugin/relight-studio",
    )
    const manifest = parsePluginManifest(
      await readJson(path.join(packageRoot, "manifest.json")),
      "plugin/relight-studio manifest",
    )

    expect(metadata).toEqual({
      schema: "convax.package/1",
      kind: "plugin",
      id: "relight-studio",
      name: "重打光",
      description: manifest.description,
      version: "0.1.2",
      license: "MIT",
      compatibility: {
        pluginSchema: "convax.plugin/3",
        pluginHost: "convax.plugin-host/3",
      },
      yanked: false,
    })
    expect(manifest).toEqual(expect.objectContaining({
      schema: "convax.plugin/3",
      id: metadata.id,
      name: metadata.name,
      description: metadata.description,
      version: metadata.version,
      entry: "index.html",
      capabilities: [
        "canvas.connectedImages.read",
        "canvas.node.write",
        "generation.execute",
        "ui.fullscreen",
      ],
      skill: "SKILL.md",
    }))
    expect(manifest.contributes).toEqual({
      canvas: {
        renderer: { create: true, width: 1080, height: 720 },
      },
    })
    expect(manifest).not.toHaveProperty("runtime")
    expect(manifest.contributes).not.toHaveProperty("generation")
    expect(metadata).not.toHaveProperty("companions")
  })

  test("selects only generic reference-image generation tools", () => {
    expect(normalizeGenerationTools({
      tools: [
        {
          id: "example-vendor/image-a",
          title: "Image A",
          description: "Accepts image references.",
          kind: "model",
          output: "image",
          acceptedInputs: ["reference_image"],
        },
        {
          id: "example-vendor/image-without-reference",
          title: "Prompt-only image",
          kind: "model",
          output: "image",
          acceptedInputs: [],
        },
        {
          id: "example-vendor/video-a",
          title: "Video A",
          kind: "model",
          output: "video",
          acceptedInputs: ["reference_image"],
        },
        {
          id: "example-vendor/image-operation",
          title: "Image operation",
          kind: "operation",
          output: "image",
          acceptedInputs: ["reference_image"],
        },
        {
          id: "example-vendor/image-a",
          title: "Duplicate Image A",
          kind: "model",
          output: "image",
          acceptedInputs: ["reference_image"],
        },
      ],
    })).toEqual([{
      id: "example-vendor/image-a",
      title: "Image A",
      description: "Accepts image references.",
    }])
  })

  test("drains Plugin state before requesting a pending Canvas generation node", async () => {
    const request = buildRelightGenerationRequest({
      prompt: "Relight this image.",
      referenceNodeId: "source-image",
      toolId: "example-vendor/image-a",
    })
    expect(request).toEqual({
      output: "image",
      prompt: "Relight this image.",
      references: [{ nodeId: "source-image", role: "reference_image" }],
      resultMode: "create-pending-node",
      toolId: "example-vendor/image-a",
    })
    expect(request).not.toHaveProperty("nodeId")

    const app = await fs.readFile(path.join(packageRoot, "assets", "app.js"), "utf8")
    const generateStart = app.indexOf("async function generateRelight()")
    const generateEnd = app.indexOf("\nfunction bindControls()", generateStart)
    expect(generateStart).toBeGreaterThanOrEqual(0)
    expect(generateEnd).toBeGreaterThan(generateStart)
    const generate = app.slice(generateStart, generateEnd)
    const drainIndex = generate.indexOf("await drainStateSave()")
    const executeIndex = generate.indexOf('hostRequest(\n      "generation.canvas.execute"')
    expect(drainIndex).toBeGreaterThanOrEqual(0)
    expect(executeIndex).toBeGreaterThan(drainIndex)
    expect(generate.slice(0, executeIndex)).not.toContain("void flushStateSave()")
    expect(generate.slice(executeIndex)).toContain("void flushStateSave()")

    const queueStart = app.indexOf("function queueStateSave()")
    const queueEnd = app.indexOf("\nasync function flushStateSave", queueStart)
    expect(app.slice(queueStart, queueEnd)).toContain("if (generationInFlight) return")
    const flushStart = queueEnd
    const flushEnd = app.indexOf("\nasync function drainStateSave", flushStart)
    expect(app.slice(flushStart, flushEnd)).toContain("(!allowDuringGeneration && generationInFlight)")
  })

  test("ships Radix Select, Slider, and Tooltip as a self-contained local browser bundle", async () => {
    const workspace = await readJson(path.join(sourceRoot, "package.json"))
    expect(workspace.scripts).toMatchObject({
      build: "bun scripts/build.ts",
      typecheck: expect.stringContaining("tsc --noEmit"),
    })
    expect(workspace.devDependencies).toMatchObject({
      "radix-ui": "1.6.2",
      react: "19.2.4",
      "react-dom": "19.2.4",
    })

    const [html, source, bundle] = await Promise.all([
      fs.readFile(path.join(packageRoot, "index.html"), "utf8"),
      fs.readFile(path.join(sourceRoot, "src", "radix-controls.tsx"), "utf8"),
      fs.readFile(path.join(packageRoot, "assets", "radix-controls.js"), "utf8"),
    ])
    expect(html.match(/data-radix-select/g)).toHaveLength(2)
    expect(html.match(/data-radix-slider/g)).toHaveLength(8)
    expect(source).toContain('import { Select, Slider, Tooltip } from "radix-ui"')
    expect(source).toContain("<Select.Root")
    expect(source).toContain("<Slider.Root")
    expect(source).toContain("<Tooltip.Root")
    expect(bundle.length).toBeGreaterThan(1_000)
    expect(bundle).not.toMatch(/https?:\/\//)
    expect(bundle).not.toMatch(/from\s*["'](?:radix-ui|react|react-dom)/)
  })

  test("keeps the install package inert and documents real host generation", async () => {
    const files = await collectFiles(packageRoot, "plugin/relight-studio")
    const names = files.map((file) => file.relativePath)

    expect(names).toEqual(expect.arrayContaining([
      "LICENSE",
      "SKILL.md",
      "assets/radix-controls.js",
      "index.html",
      "manifest.json",
    ]))
    expect(() => assertPluginStatic(files, "plugin/relight-studio")).not.toThrow()

    const skill = files.find((file) => file.relativePath === "SKILL.md")?.data.toString("utf8") ?? ""
    expect(skill).toContain("generation.tools.list")
    expect(skill).toContain("generation.canvas.execute")
    expect(skill).toContain("created Canvas node")
    expect(skill).not.toContain("local preview only")
  })
})
