import { describe, expect, test } from "bun:test"

import { parsePluginManifest, parseSourceMetadata } from "./lib.mjs"

function manifest(overrides = {}) {
  return {
    schema: "convax.plugin/4",
    id: "example-tools",
    name: "Example Tools",
    description: "Provides a Tool and Plugin-owned Skill.",
    version: "1.0.0",
    contributes: {
      generation: {
        models: [],
        tools: [{
          id: "video.trim",
          title: "Trim video",
          description: "Create a video from a selected time range.",
          output: "video",
          acceptedInputs: ["reference_video"],
        }],
      },
      skills: [{ name: "example-workflow", path: "skills/example-workflow" }],
    },
    runtime: { type: "mcp-stdio", command: "example-tools-mcp" },
    ...overrides,
  }
}

describe("convax.plugin/4 owned Skill contributions", () => {
  test("normalizes Plugin-owned Skill identities and paths", () => {
    const parsed = parsePluginManifest(manifest())
    expect(parsed.schema).toBe("convax.plugin/4")
    expect(parsed.contributes.skills).toEqual([
      { name: "example-workflow", path: "skills/example-workflow" },
    ])
    expect(parsed).not.toHaveProperty("skill")
  })

  test("accepts a static Canvas Plugin as a real capability beyond its owned Skills", () => {
    const parsed = parsePluginManifest(manifest({
      entry: "index.html",
      contributes: {
        canvas: {
          renderer: { create: true, width: 480, height: 300 },
        },
        skills: [{ name: "example-workflow", path: "skills/example-workflow" }],
      },
      runtime: undefined,
    }))

    expect(parsed.entry).toBe("index.html")
    expect(parsed.contributes.canvas.renderer.create).toBe(true)
  })

  test("accepts only the matching v4 package and host pair", () => {
    const parsed = parseSourceMetadata({
      schema: "convax.package/1",
      kind: "plugin",
      id: "example-tools",
      name: "Example Tools",
      description: "Provides a Tool and Plugin-owned Skill.",
      version: "1.0.0",
      license: "MIT",
      compatibility: { pluginSchema: "convax.plugin/4", pluginHost: "convax.plugin-host/4" },
      yanked: false,
    })
    expect(parsed.compatibility).toEqual({
      pluginSchema: "convax.plugin/4",
      pluginHost: "convax.plugin-host/4",
    })
    expect(() => parseSourceMetadata({
      ...parsed,
      license: "MIT",
      compatibility: { pluginSchema: "convax.plugin/4", pluginHost: "convax.plugin-host/3" },
    })).toThrow("matching convax.plugin and convax.plugin-host")
  })

  test("rejects legacy, duplicate, and noncanonical Skill declarations", () => {
    const legacy = manifest({ skill: "skills/example-workflow/SKILL.md" })
    expect(() => parsePluginManifest(legacy)).toThrow("unsupported field skill")

    const duplicate = manifest()
    duplicate.contributes.skills.push({ name: "example-workflow", path: "skills/example-workflow" })
    expect(() => parsePluginManifest(duplicate)).toThrow("duplicate names")

    const filePath = manifest()
    filePath.contributes.skills[0].path = "skills/example-workflow/SKILL.md"
    expect(() => parsePluginManifest(filePath)).toThrow("path must equal skills/example-workflow")

    const mismatched = manifest()
    mismatched.contributes.skills[0].path = "skills/another-workflow"
    expect(() => parsePluginManifest(mismatched)).toThrow("path must equal skills/example-workflow")
  })

  test("keeps ownerPluginId exclusive to Skill source metadata", () => {
    const skill = parseSourceMetadata({
      schema: "convax.package/1",
      kind: "skill",
      id: "example-workflow",
      name: "Example Workflow",
      description: "Uses the Example Tools Plugin when it is available.",
      version: "1.0.0",
      license: "MIT",
      compatibility: { skillSchema: "opencode.skill/1" },
      ownerPluginId: "example-tools",
      yanked: false,
    })
    expect(skill.ownerPluginId).toBe("example-tools")

    expect(() => parseSourceMetadata({
      schema: "convax.package/1",
      kind: "plugin",
      id: "example-tools",
      name: "Example Tools",
      description: "Provides a Tool and Plugin-owned Skill.",
      version: "1.0.0",
      license: "MIT",
      compatibility: { pluginSchema: "convax.plugin/4", pluginHost: "convax.plugin-host/4" },
      ownerPluginId: "another-plugin",
      yanked: false,
    })).toThrow("ownerPluginId is available only to Skills")
  })
})
