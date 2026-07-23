import { describe, expect, test } from "bun:test"
import { promises as fs } from "node:fs"
import path from "node:path"

import {
  assertPluginStatic,
  collectFiles,
  parsePluginManifest,
  parseSourceMetadata,
  readJson,
  root,
} from "./lib.mjs"

const sourceRoot = path.join(root, "packages", "plugins", "panorama-viewer")
const packageRoot = path.join(sourceRoot, "package")

describe("panorama-viewer package", () => {
  test("ships one static Chinese Panorama Viewer with explicit viewport capture authority", async () => {
    const metadata = parseSourceMetadata(
      await readJson(path.join(sourceRoot, "convax-package.json")),
      "plugin/panorama-viewer",
    )
    const manifest = parsePluginManifest(
      await readJson(path.join(packageRoot, "manifest.json")),
      "plugin/panorama-viewer manifest",
    )

    expect(metadata).toEqual({
      schema: "convax.package/1",
      kind: "plugin",
      id: "panorama-viewer",
      name: "全景图预览",
      description: manifest.description,
      version: "0.2.1",
      license: "MIT",
      compatibility: {
        pluginSchema: "convax.plugin/1",
        pluginHost: "convax.plugin-host/1",
      },
      yanked: false,
    })
    expect(manifest).toEqual(expect.objectContaining({
      schema: "convax.plugin/1",
      id: metadata.id,
      name: metadata.name,
      description: metadata.description,
      version: metadata.version,
      entry: "index.html",
      capabilities: [
        "canvas.connectedImages.read",
        "canvas.image.write",
        "canvas.node.write",
        "ui.fullscreen",
      ],
    }))
    expect(manifest.contributes.canvas.toolbar).toEqual([
      { command: "panorama.capture-viewport", id: "capture-viewport", title: "截取画面" },
      { command: "panorama.reset", id: "reset", title: "重置视角" },
      { command: "panorama.toggle-auto-rotate", id: "auto-rotate", title: "自动旋转" },
      { command: "panorama.refresh-connections", id: "refresh", title: "刷新图片" },
    ])
  })

  test("contains only offline static browser files and implements PNG viewport capture", async () => {
    const files = await collectFiles(packageRoot, 0)
    assertPluginStatic(files, "plugin/panorama-viewer")
    expect(files.map((file) => file.relativePath)).toEqual([
      "LICENSE",
      "assets/app.js",
      "assets/panorama-image.js",
      "assets/panorama-renderer.js",
      "assets/styles.css",
      "index.html",
      "manifest.json",
    ])

    const [app, renderer] = await Promise.all([
      fs.readFile(path.join(packageRoot, "assets", "app.js"), "utf8"),
      fs.readFile(path.join(packageRoot, "assets", "panorama-renderer.js"), "utf8"),
    ])
    expect(app).toContain('hostRequest("canvas.image.create"')
    expect(app).toContain("全景视口截图.png")
    expect(renderer).toContain("gl.readPixels")
    expect(renderer).toContain('output.toBlob')
  })
})
