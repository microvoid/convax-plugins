import { describe, expect, test } from "bun:test"
import { promises as fs } from "node:fs"
import path from "node:path"

import { root } from "./lib.mjs"

const packageRoot = path.join(root, "packages", "plugins", "subtitle-studio", "package")

describe("Subtitle Studio package boundary", () => {
  test("uses only generic v3 host capabilities and a separately declared companion", async () => {
    const [source, manifest] = await Promise.all([
      fs.readFile(path.join(root, "packages", "plugins", "subtitle-studio", "convax-package.json"), "utf8").then(JSON.parse),
      fs.readFile(path.join(packageRoot, "manifest.json"), "utf8").then(JSON.parse),
    ])

    expect(manifest.capabilities.includes("canvas.node.read")).toBe(false)
    expect(manifest).toMatchObject({
      capabilities: expect.arrayContaining([
        "agent.prompt",
        "canvas.connectedMedia.read",
        "canvas.node.write",
        "generation.execute",
        "host.files.save",
      ]),
      runtime: { command: "convax-subtitle-studio-mcp", type: "mcp-stdio" },
      schema: "convax.plugin/3",
    })
    expect(source.companions).toEqual([
      expect.objectContaining({
        command: "convax-subtitle-studio-mcp",
        source: "tools/subtitle-studio-mcp",
        targets: [{ arch: "arm64", platform: "darwin", path: "dist/darwin-arm64/convax-subtitle-studio-mcp" }],
      }),
    ])
  })

  test("keeps media, generation, and translation on generic host methods", async () => {
    const application = await fs.readFile(path.join(packageRoot, "assets", "app.js"), "utf8")
    for (const method of [
      "canvas.connectedMedia.list",
      "canvas.connectedMedia.playback.open",
      "sourceVersion",
      "generation.workspace.execute",
      "generation.workspace.publish",
      "generation.workspace.export",
      'mode: "text-only"',
      "generation.workspace.release",
    ]) {
      expect(application).toContain(method)
    }
    for (const privateSurface of [
      "subtitle.sources.list",
      "subtitle.operation.run",
      "subtitle.document.read",
      "subtitle.translation.prepare",
      "window.convax.subtitle",
      "convax-subtitle-media",
    ]) {
      expect(application).not.toContain(privateSurface)
    }
    expect(application).toContain("state.documentSourceVersion !== source.sourceVersion")
    expect(application).toContain("source.sourceVersion === state.source?.sourceVersion")
  })

  test("keeps the player fitted above a separate subtitle timeline", async () => {
    const [html, styles] = await Promise.all([
      fs.readFile(path.join(packageRoot, "index.html"), "utf8"),
      fs.readFile(path.join(packageRoot, "assets", "styles.css"), "utf8"),
    ])
    expect(html).toContain('class="player-pane"')
    expect(html).toContain('class="timeline"')
    expect(html).toContain('id="editPanel"')
    expect(html).toContain('id="saveCue"')
    expect(styles).toContain("object-fit: contain")
    expect(styles).toContain("grid-template-rows: minmax(0, 1fr) 210px")
    expect(html).not.toContain('type="range"')
  })

  test("blocks publishing until the complete pinned local runtime is packaged", async () => {
    const [workflow, entrypoint, installedRuntime] = await Promise.all([
      fs.readFile(path.join(root, ".github", "workflows", "publish.yml"), "utf8"),
      fs.readFile(path.join(root, "tools", "subtitle-studio-mcp", "src", "main.ts"), "utf8"),
      fs.readFile(path.join(root, "tools", "subtitle-studio-mcp", "src", "runtime", "installed.ts"), "utf8"),
    ])
    expect(workflow).toContain("Block source-only Subtitle Studio releases")
    expect(workflow).toContain("startsWith(github.ref_name, 'plugin-subtitle-studio-v')")
    expect(entrypoint).toContain("loadInstalledSubtitleRuntime")
    expect(installedRuntime).toContain('path.join(path.dirname(companionExecutablePath), "runtime")')
    expect(`${entrypoint}\n${installedRuntime}`).not.toContain("process.env")
  })
})
