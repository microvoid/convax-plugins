import { describe, expect, test } from "bun:test"
import path from "node:path"

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
      version: "0.1.0",
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

  test("keeps the install package inert and documents real host generation", async () => {
    const files = await collectFiles(packageRoot, "plugin/relight-studio")
    const names = files.map((file) => file.relativePath)

    expect(names).toEqual(expect.arrayContaining(["LICENSE", "SKILL.md", "index.html", "manifest.json"]))
    expect(() => assertPluginStatic(files, "plugin/relight-studio")).not.toThrow()

    const skill = files.find((file) => file.relativePath === "SKILL.md")?.data.toString("utf8") ?? ""
    expect(skill).toContain("generation.tools.list")
    expect(skill).toContain("generation.canvas.execute")
    expect(skill).toContain("created Canvas node")
    expect(skill).not.toContain("local preview only")
  })
})
