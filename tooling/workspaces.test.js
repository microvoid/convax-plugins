import { describe, expect, test } from "bun:test"
import { promises as fs } from "node:fs"
import os from "node:os"
import path from "node:path"

import { discoverPackages, readJson, root } from "./lib.mjs"
import { packFromArgs } from "./pack.mjs"
import { runWorkspaceScript } from "./run-workspace-script.mjs"

const collections = ["plugins", "skills", "tools"]

describe("Bun workspace ownership", () => {
  test("discovers every Plugin, Skill, and Tool from the root workspace globs", async () => {
    const rootPackage = await readJson(path.join(root, "package.json"))
    expect(rootPackage.workspaces).toEqual([
      "packages/plugins/*",
      "packages/skills/*",
      "packages/tools/*",
    ])

    for (const collection of collections) {
      const directory = path.join(root, "packages", collection)
      const entries = await fs.readdir(directory, { withFileTypes: true })
      for (const entry of entries.filter((item) => item.isDirectory())) {
        const workspace = await readJson(path.join(directory, entry.name, "package.json"))
        expect(workspace.private).toBe(true)
        expect(workspace.type).toBe("module")
        expect(typeof workspace.name).toBe("string")
        expect(typeof workspace.version).toBe("string")
        await expect(fs.stat(path.join(directory, entry.name, "bun.lock"))).rejects.toMatchObject({ code: "ENOENT" })
      }
    }
  })

  test("keeps one frozen root lockfile", async () => {
    const lock = await readJson(path.join(root, "bun.lock"))
    expect(lock.lockfileVersion).toBe(1)
    expect(Object.keys(lock.workspaces)).toContain("packages/tools/ffmpeg-mcp")
    expect(Object.keys(lock.workspaces)).toContain("packages/skills/ffmpeg-canvas")
  })

  test("runs package builds in dependency order before repository validation and packing", async () => {
    const fixture = await fs.mkdtemp(path.join(os.tmpdir(), "convax-workspace-build-"))
    try {
      const skill = path.join(fixture, "packages", "skills", "source-skill")
      const plugin = path.join(fixture, "packages", "plugins", "owner-plugin")
      await fs.mkdir(skill, { recursive: true })
      await fs.mkdir(plugin, { recursive: true })
      await fs.writeFile(path.join(skill, "package.json"), JSON.stringify({
        name: "fixture-skill",
        scripts: { build: "bun build.mjs" },
      }))
      await fs.writeFile(path.join(skill, "build.mjs"), [
        'import { promises as fs } from "node:fs"',
        'await fs.mkdir("package", { recursive: true })',
        'await fs.writeFile("package/generated.txt", "skill-built")',
      ].join("\n"))
      await fs.writeFile(path.join(plugin, "package.json"), JSON.stringify({
        name: "fixture-plugin",
        scripts: { build: "bun build.mjs" },
      }))
      await fs.writeFile(path.join(plugin, "build.mjs"), [
        'import { promises as fs } from "node:fs"',
        'const source = await fs.readFile("../../skills/source-skill/package/generated.txt", "utf8")',
        'await fs.mkdir("package", { recursive: true })',
        'await fs.writeFile("package/embedded.txt", source + ":plugin-built")',
      ].join("\n"))

      expect(await runWorkspaceScript("build", ["skills", "plugins"], fixture)).toEqual([
        "skills/source-skill",
        "plugins/owner-plugin",
      ])
      expect(await fs.readFile(path.join(plugin, "package", "embedded.txt"), "utf8")).toBe(
        "skill-built:plugin-built",
      )

      const rootPackage = await readJson(path.join(root, "package.json"))
      expect(rootPackage.scripts.check.indexOf("workspaces:build:packages")).toBeLessThan(
        rootPackage.scripts.check.indexOf("validate"),
      )
      expect(rootPackage.scripts.check.indexOf("workspaces:build:packages")).toBeLessThan(
        rootPackage.scripts.check.indexOf("bun run pack"),
      )
    } finally {
      await fs.rm(fixture, { force: true, recursive: true })
    }
  })

  test("loads only the selected package and its required ownership closure", async () => {
    const ffmpegClosure = await discoverPackages({ kind: "plugin", id: "ffmpeg-tools" })
    expect(ffmpegClosure.map((pkg) => `${pkg.kind}/${pkg.id}`)).toEqual([
      "plugin/ffmpeg-tools",
      "skill/ffmpeg-canvas",
    ])

    const fixture = await fs.mkdtemp(path.join(os.tmpdir(), "convax-workspace-selection-"))
    try {
      const target = path.join(fixture, "packages", "skills", "target-skill")
      const broken = path.join(fixture, "packages", "skills", "broken-sibling")
      await fs.mkdir(path.join(target, "package"), { recursive: true })
      await fs.mkdir(broken, { recursive: true })
      await fs.writeFile(path.join(target, "package.json"), JSON.stringify({
        name: "@microvoid/convax-skill-target-skill",
        version: "1.0.0",
        private: true,
        type: "module",
        scripts: { validate: "true", pack: "true" },
      }))
      await fs.writeFile(path.join(target, "convax-package.json"), JSON.stringify({
        schema: "convax.package/1",
        kind: "skill",
        id: "target-skill",
        name: "Target Skill",
        description: "A valid target used to verify workspace selection.",
        version: "1.0.0",
        license: "MIT",
        compatibility: { skillSchema: "opencode.skill/1" },
        yanked: false,
      }))
      await fs.writeFile(path.join(target, "package", "SKILL.md"), [
        "---",
        "name: target-skill",
        "description: Verify that one selected workspace ignores an unrelated broken sibling.",
        "---",
        "",
        "# Target Skill",
        "",
        "Return the verified target result.",
      ].join("\n"))
      await fs.writeFile(path.join(broken, "convax-package.json"), "{")

      const selected = await discoverPackages({
        kind: "skill",
        id: "target-skill",
        workspaceRoot: fixture,
      })
      expect(selected.map((pkg) => `${pkg.kind}/${pkg.id}`)).toEqual(["skill/target-skill"])
      await expect(discoverPackages({ workspaceRoot: fixture })).rejects.toThrow("invalid JSON")
    } finally {
      await fs.rm(fixture, { force: true, recursive: true })
    }
  })

  test("single-package packing preserves sibling outputs", async () => {
    const outputDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "convax-workspace-pack-"))
    try {
      const siblingFile = path.join(outputDirectory, "skill-existing-v1.0.0", "keep.txt")
      await fs.mkdir(path.dirname(siblingFile), { recursive: true })
      await fs.writeFile(siblingFile, "keep")

      const [packed] = await packFromArgs(
        ["--kind", "plugin", "--id", "hello-convax"],
        { outputDirectory },
      )

      expect(await fs.readFile(siblingFile, "utf8")).toBe("keep")
      expect(packed.tag).toBe("plugin-hello-convax-v0.1.0")
      expect((await fs.stat(packed.zipPath)).isFile()).toBe(true)
    } finally {
      await fs.rm(outputDirectory, { force: true, recursive: true })
    }
  })
})
