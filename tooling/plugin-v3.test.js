import { describe, expect, test } from "bun:test"

import { parsePluginManifest, parseSourceMetadata } from "./lib.mjs"

function generationTools() {
  return [
    {
      id: "video.trim",
      title: "Trim video",
      description: "Create a video from a selected time range.",
      output: "video",
      acceptedInputs: ["reference_video"],
    },
    {
      id: "audio.extract",
      title: "Extract audio",
      description: "Create an audio-only file from a video.",
      output: "audio",
      acceptedInputs: ["reference_video"],
    },
  ]
}

function manifest(overrides = {}) {
  return {
    schema: "convax.plugin/3",
    id: "example-tools",
    name: "Example Tools",
    description: "Provides injected media operations.",
    version: "1.0.0",
    contributes: {
      generation: { models: [], tools: generationTools() },
      agent: { tools: [{ id: "trim_video", tool: "video.trim" }] },
      canvas: {
        selectionActions: [{
          id: "trim",
          title: { default: "Trim", "zh-CN": "截取" },
          description: { default: "Choose a time range." },
          target: "video",
          editor: "time-range",
          steps: [{ tool: "video.trim" }],
        }],
      },
    },
    runtime: { type: "mcp-stdio", command: "example-tools-mcp" },
    ...overrides,
  }
}

describe("convax.plugin/3 declarative contributions", () => {
  test("normalizes explicit models, Agent tools, and Canvas selection actions", () => {
    const source = manifest()
    source.contributes.generation.models = [{ tool: "audio.extract", name: "Audio Pro" }]
    const parsed = parsePluginManifest(source)

    expect(parsed.schema).toBe("convax.plugin/3")
    expect(parsed.contributes.generation.models).toEqual([{ name: "Audio Pro", tool: "audio.extract" }])
    expect(parsed.contributes.agent.tools).toEqual([{ id: "trim_video", tool: "video.trim" }])
    expect(parsed.contributes.canvas.selectionActions[0]).toEqual(expect.objectContaining({
      editor: "time-range",
      id: "trim",
      steps: [{ tool: "video.trim" }],
      target: "video",
    }))
    expect(parsed).not.toHaveProperty("entry")
  })

  test("accepts the matching v3 package/host compatibility pair", () => {
    const parsed = parseSourceMetadata({
      schema: "convax.package/1",
      kind: "plugin",
      id: "example-tools",
      name: "Example Tools",
      description: "Provides injected media operations.",
      version: "1.0.0",
      license: "MIT",
      compatibility: { pluginSchema: "convax.plugin/3", pluginHost: "convax.plugin-host/3" },
      yanked: false,
    })
    expect(parsed.compatibility).toEqual({
      pluginSchema: "convax.plugin/3",
      pluginHost: "convax.plugin-host/3",
    })
  })

  test("keeps execution tools out of the model catalog unless explicitly referenced", () => {
    const parsed = parsePluginManifest(manifest())
    expect(parsed.contributes.generation.tools.map((tool) => tool.id)).toEqual(["video.trim", "audio.extract"])
    expect(parsed.contributes.generation.models).toEqual([])
  })

  test("requires every model, Agent tool, and action step to reference a declared execution tool", () => {
    for (const mutate of [
      (value) => { value.contributes.generation.models = [{ tool: "missing", name: "Missing" }] },
      (value) => { value.contributes.agent.tools[0].tool = "missing" },
      (value) => { value.contributes.canvas.selectionActions[0].steps[0].tool = "missing" },
    ]) {
      const value = manifest()
      mutate(value)
      expect(() => parsePluginManifest(value)).toThrow("unknown generation tool")
    }
  })

  test("requires an explicit model catalog, while allowing operation-only Plugins", () => {
    const missing = manifest()
    delete missing.contributes.generation.models
    expect(() => parsePluginManifest(missing)).toThrow("missing field models")
    expect(parsePluginManifest(manifest()).contributes.generation.models).toEqual([])
  })

  test("rejects duplicate declaration ids, names, and references", () => {
    const duplicateModels = manifest()
    duplicateModels.contributes.generation.models = [
      { tool: "video.trim", name: "One" },
      { tool: "video.trim", name: "Two" },
    ]
    expect(() => parsePluginManifest(duplicateModels)).toThrow("duplicate tool references")

    const duplicateModelNames = manifest()
    duplicateModelNames.contributes.generation.models = [
      { tool: "video.trim", name: "Same" },
      { tool: "audio.extract", name: "Same" },
    ]
    expect(() => parsePluginManifest(duplicateModelNames)).toThrow("duplicate names")

    const duplicateAgentIds = manifest()
    duplicateAgentIds.contributes.agent.tools.push({ id: "trim_video", tool: "audio.extract" })
    expect(() => parsePluginManifest(duplicateAgentIds)).toThrow("duplicate ids")

    const duplicateAgentReferences = manifest()
    duplicateAgentReferences.contributes.agent.tools.push({ id: "trim_again", tool: "video.trim" })
    expect(() => parsePluginManifest(duplicateAgentReferences)).toThrow("duplicate generation tool references")

    const duplicateActions = manifest()
    duplicateActions.contributes.canvas.selectionActions.push({
      ...duplicateActions.contributes.canvas.selectionActions[0],
    })
    expect(() => parsePluginManifest(duplicateActions)).toThrow("duplicate ids")

    const duplicateSteps = manifest()
    duplicateSteps.contributes.canvas.selectionActions[0].editor = "confirmation"
    duplicateSteps.contributes.canvas.selectionActions[0].steps.push({ tool: "video.trim" })
    expect(() => parsePluginManifest(duplicateSteps)).toThrow("duplicate tool references")
  })

  test("requires a generation contribution for Agent tools and selection actions", () => {
    const agentOnly = manifest({
      contributes: {
        agent: { tools: [{ id: "trim_video", tool: "video.trim" }] },
        service: { actions: [] },
      },
    })
    expect(() => parsePluginManifest(agentOnly)).toThrow("agent tools require a generation contribution")

    const actionOnly = manifest({
      contributes: {
        canvas: manifest().contributes.canvas,
        service: { actions: [] },
      },
    })
    expect(() => parsePluginManifest(actionOnly)).toThrow("selectionActions require a generation contribution")
  })

  test("keeps model tools out of Agent and Canvas actions", () => {
    const agentModel = manifest()
    agentModel.contributes.generation.models = [{ name: "Trim Pro", tool: "video.trim" }]
    expect(() => parsePluginManifest(agentModel)).toThrow("non-model generation tool")

    const actionModel = manifest()
    actionModel.contributes.generation.models = [{ name: "Trim Pro", tool: "video.trim" }]
    delete actionModel.contributes.agent
    expect(() => parsePluginManifest(actionModel)).toThrow("non-model generation tool")
  })

  test("requires video actions to use reference-video tools and single-step interactive editors", () => {
    const wrongInput = manifest()
    wrongInput.contributes.generation.tools[0].acceptedInputs = ["reference_image"]
    expect(() => parsePluginManifest(wrongInput)).toThrow("must accept reference_video")

    const extraStep = manifest()
    extraStep.contributes.canvas.selectionActions[0].steps.push({ tool: "audio.extract" })
    expect(() => parsePluginManifest(extraStep)).toThrow("exactly one step")

    const longTitle = manifest()
    longTitle.contributes.canvas.selectionActions[0].title.default = "x".repeat(121)
    expect(() => parsePluginManifest(longTitle)).toThrow("must be a non-empty trimmed string")
  })

  test("enforces stable Agent ids and the 32-tool bound", () => {
    const invalid = manifest()
    invalid.contributes.agent.tools[0].id = "trim-video"
    expect(() => parsePluginManifest(invalid)).toThrow("lowercase letters, digits, and underscores")

    const tooMany = manifest()
    tooMany.contributes.agent.tools = Array.from({ length: 33 }, (_, index) => ({
      id: `tool_${index}`,
      tool: index === 0 ? "video.trim" : `missing.${index}`,
    }))
    expect(() => parsePluginManifest(tooMany)).toThrow("at most 32")
  })

  test("allows a Canvas contribution without an iframe and gates toolbar on a renderer", () => {
    expect(parsePluginManifest(manifest()).contributes.canvas).not.toHaveProperty("renderer")

    const emptyCanvas = manifest()
    emptyCanvas.contributes.canvas = {}
    expect(() => parsePluginManifest(emptyCanvas)).toThrow("renderer or selectionActions")

    const toolbarOnly = manifest()
    toolbarOnly.contributes.canvas = {
      toolbar: [{ id: "open", title: "Open", command: "open" }],
    }
    expect(() => parsePluginManifest(toolbarOnly)).toThrow("toolbar requires a renderer")
  })

  test("pairs entry only with a renderer and keeps renderer host capabilities scoped", () => {
    const renderer = manifest()
    renderer.entry = "index.html"
    renderer.contributes.canvas.renderer = { mimeTypes: ["video/mp4"] }
    expect(parsePluginManifest(renderer).entry).toBe("index.html")

    const entryWithoutRenderer = manifest({ entry: "index.html" })
    expect(() => parsePluginManifest(entryWithoutRenderer)).toThrow("entry and Canvas renderer")

    for (const capability of ["generation.execute", "canvas.connectedMedia.read", "host.files.save"]) {
      const capabilityWithoutRenderer = manifest({ capabilities: [capability] })
      expect(() => parsePluginManifest(capabilityWithoutRenderer)).toThrow("sandboxed Canvas renderer")
    }

    for (const capability of ["canvas.connectedMedia.read", "host.files.save"]) {
      const rendererOnly = manifest({
        capabilities: [capability],
        contributes: { canvas: { renderer: { create: true, height: 480, width: 640 } } },
        entry: "index.html",
        runtime: undefined,
      })
      expect(parsePluginManifest(rendererOnly).capabilities).toEqual([capability])
    }
  })

  test("does not backport v3 fields into the v2 protocol", () => {
    const v2 = manifest()
    v2.schema = "convax.plugin/2"
    expect(() => parsePluginManifest(v2)).toThrow("unsupported field agent")

    const v2Models = manifest()
    v2Models.schema = "convax.plugin/2"
    v2Models.contributes = { generation: v2Models.contributes.generation }
    v2Models.contributes.generation.models = [{ tool: "video.trim", name: "Trim Pro" }]
    expect(() => parsePluginManifest(v2Models)).toThrow("unsupported field models")
  })
})
