import { createHash } from "node:crypto"
import { promises as fs } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

export const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)))
export const repository = "microvoid/convax-plugins"
export const registrySchema = "convax.registry/1"
export const showcaseSchema = "convax.showcase/1"
export const showcaseEntrySchema = "convax.showcase-entry/1"
export const maxFileBytes = 2 * 1024 * 1024
export const maxPackageBytes = 10 * 1024 * 1024
export const maxPluginEntries = 2_000
export const maxSkillEntries = 512
export const maxPosterBytes = 5 * 1024 * 1024
export const maxAnimationBytes = 20 * 1024 * 1024
export const maxCompanionBytes = 128 * 1024 * 1024

const semverPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/
const idPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const windowsReservedName = /^(CON|PRN|AUX|NUL|COM[1-9¹²³]|LPT[1-9¹²³]|CONIN\$|CONOUT\$)$/i
const pluginCapabilities = new Set([
  "canvas.connectedImages.read",
  "canvas.image.write",
  "canvas.node.read",
  "canvas.node.write",
  "project.files.read",
  "agent.prompt",
  "generation.execute",
  "ui.fullscreen",
  "projects.read",
  "canvas.catalog.read",
  "canvas.document.read",
  "canvas.document.write",
  "canvas.events.subscribe",
  "pet.activity.read",
  "pet.activity.open",
  "pet.preferences.write",
])
const pluginV5Capabilities = new Set([
  "projects.read",
  "canvas.catalog.read",
  "canvas.document.read",
  "canvas.document.write",
  "canvas.events.subscribe",
  "pet.activity.read",
  "pet.activity.open",
  "pet.preferences.write",
])
const generationModalities = new Set(["text", "image", "video", "audio"])
const generationInputRoles = new Set([
  "reference_image",
  "reference_video",
  "first_frame",
  "last_frame",
  "audio",
  "text",
])
const companionPlatforms = new Set(["darwin", "linux", "win32"])
const companionArchitectures = new Set(["arm64", "x64"])
const nativeExtensions = new Set([".app", ".bat", ".cmd", ".com", ".dll", ".dylib", ".exe", ".msi", ".node", ".ps1", ".so", ".wasm"])
const pluginExecutableSourceExtensions = new Set([".cjs", ".fish", ".jar", ".php", ".pl", ".py", ".rb", ".sh", ".ts", ".tsx", ".zsh"])
const showcaseMimes = {
  poster: new Map([["image/jpeg", ".jpg"], ["image/png", ".png"], ["image/webp", ".webp"]]),
  animation: new Map([["image/gif", ".gif"], ["video/mp4", ".mp4"]]),
}

function error(label, message) {
  throw new Error(`${label}: ${message}`)
}

export function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

export function exactKeys(value, allowed, required, label) {
  if (!isObject(value)) error(label, "must be an object")
  const allowedSet = new Set(allowed)
  const unknown = Object.keys(value).find((key) => !allowedSet.has(key))
  if (unknown) error(label, `unsupported field ${unknown}`)
  const missing = required.find((key) => !(key in value))
  if (missing) error(label, `missing field ${missing}`)
  return value
}

function cleanString(value, label, maxLength) {
  if (typeof value !== "string" || value !== value.trim() || value.length === 0 ||
      value.length > maxLength || /[\u0000-\u001f\u007f]/.test(value)) {
    error(label, "must be a non-empty trimmed string")
  }
  return value
}

export function parseId(value, label = "id") {
  const result = cleanString(value, label, 80)
  if (!idPattern.test(result)) error(label, "must use kebab-case")
  validatePortableSegment(result, label)
  return result
}

export function parseSemver(value, label = "version") {
  const result = cleanString(value, label, 128)
  if (!semverPattern.test(result)) error(label, "must be valid SemVer")
  return result
}

function parseShowcaseSourceMedia(value, role, label) {
  exactKeys(value, ["alt", "height", "mime", "path", "width"], ["alt", "height", "mime", "path", "width"], label)
  const relativePath = parseRelativePath(value.path, `${label} path`)
  if (!relativePath.startsWith("showcase/") || relativePath.split("/").length !== 2) {
    error(label, "path must name one file directly below showcase/")
  }
  const mime = cleanString(value.mime, `${label} mime`, 80)
  const extension = showcaseMimes[role].get(mime)
  if (!extension) error(label, `unsupported ${role} MIME type ${mime}`)
  if (!relativePath.endsWith(extension)) error(label, `path extension must be ${extension}`)
  return {
    path: relativePath,
    alt: cleanString(value.alt, `${label} alt`, 500),
    mime,
    width: dimension(value.width, `${label} width`),
    height: dimension(value.height, `${label} height`),
  }
}

function parseShowcaseSource(value, label) {
  if (value === undefined) return undefined
  exactKeys(value, ["animation", "poster"], ["poster"], label)
  const poster = parseShowcaseSourceMedia(value.poster, "poster", `${label} poster`)
  const animation = value.animation === undefined
    ? undefined
    : parseShowcaseSourceMedia(value.animation, "animation", `${label} animation`)
  if (animation?.path === poster.path) error(label, "poster and animation must use different files")
  return { poster, ...(animation ? { animation } : {}) }
}

export function validatePortableSegment(value, label = "path") {
  const stem = value.split(".")[0] ?? ""
  if (!value || value.length > 255 || value === "." || value === ".." ||
      /[\\/:*?"<>|\u0000-\u001f\u007f]/.test(value) || /[. ]$/.test(value) ||
      windowsReservedName.test(stem)) error(label, `invalid portable segment ${value}`)
  return value
}

export function parseRelativePath(value, label = "path") {
  const result = cleanString(value, label, 1024)
  if (result.startsWith("/") || result.startsWith("//") || /^[A-Za-z]:/.test(result) || result.includes("\\")) {
    error(label, "must be a portable relative path")
  }
  const segments = result.split("/")
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) {
    error(label, "must not contain empty or traversal segments")
  }
  segments.forEach((segment) => validatePortableSegment(segment, label))
  return result
}

function parseCompatibility(value, kind, label) {
  if (kind === "plugin") {
    exactKeys(value, ["pluginSchema", "pluginHost"], ["pluginSchema", "pluginHost"], label)
    const v1 = value.pluginSchema === "convax.plugin/1" && value.pluginHost === "convax.plugin-host/1"
    const v2 = value.pluginSchema === "convax.plugin/2" && value.pluginHost === "convax.plugin-host/2"
    const v3 = value.pluginSchema === "convax.plugin/3" && value.pluginHost === "convax.plugin-host/3"
    const v4 = value.pluginSchema === "convax.plugin/4" && value.pluginHost === "convax.plugin-host/4"
    const v5 = value.pluginSchema === "convax.plugin/5" && value.pluginHost === "convax.plugin-capability/1"
    if (!v1 && !v2 && !v3 && !v4 && !v5) {
      error(label, "must pair matching convax.plugin and convax.plugin-host versions 1-4, or convax.plugin/5 with convax.plugin-capability/1")
    }
    return { pluginSchema: value.pluginSchema, pluginHost: value.pluginHost }
  }
  exactKeys(value, ["skillSchema"], ["skillSchema"], label)
  if (value.skillSchema !== "opencode.skill/1") error(label, "must target opencode.skill/1")
  return { skillSchema: "opencode.skill/1" }
}

function parseCompanionCommand(value, label) {
  const command = cleanString(value, label, 128)
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(command)) {
    error(label, "must be a bare executable name")
  }
  validatePortableSegment(command, label)
  return command
}

function parseCompanionTargetIdentity(value, label) {
  const platform = cleanString(value.platform, `${label} platform`, 16)
  const arch = cleanString(value.arch, `${label} arch`, 16)
  if (!companionPlatforms.has(platform)) error(label, `unsupported platform ${platform}`)
  if (!companionArchitectures.has(arch)) error(label, `unsupported architecture ${arch}`)
  return { platform, arch }
}

function parseSourceCompanions(value, label) {
  if (value === undefined) return undefined
  if (!Array.isArray(value) || value.length < 1 || value.length > 16) {
    error(label, "must be a non-empty array with at most 16 items")
  }
  const companions = value.map((item, index) => {
    const itemLabel = `${label} item ${index}`
    exactKeys(item, ["command", "source", "targets", "version"],
      ["command", "source", "targets", "version"], itemLabel)
    const source = parseRelativePath(item.source, `${itemLabel} source`)
    if (!/^packages\/tools\/[a-z0-9]+(?:-[a-z0-9]+)*$/.test(source)) {
      error(itemLabel, "source must name one reviewed workspace directly below packages/tools/")
    }
    if (!Array.isArray(item.targets) || item.targets.length < 1 || item.targets.length > 16) {
      error(itemLabel, "targets must be a non-empty array with at most 16 items")
    }
    const targets = item.targets.map((target, targetIndex) => {
      const targetLabel = `${itemLabel} target ${targetIndex}`
      exactKeys(target, ["arch", "path", "platform"], ["arch", "path", "platform"], targetLabel)
      return {
        ...parseCompanionTargetIdentity(target, targetLabel),
        path: parseRelativePath(target.path, `${targetLabel} path`),
      }
    })
    const identities = targets.map((target) => `${target.platform}/${target.arch}`)
    if (new Set(identities).size !== identities.length) error(itemLabel, "contains a duplicate platform/architecture target")
    return {
      command: parseCompanionCommand(item.command, `${itemLabel} command`),
      version: parseSemver(item.version, `${itemLabel} version`),
      source,
      targets,
    }
  })
  if (new Set(companions.map((item) => item.command)).size !== companions.length) {
    error(label, "contains duplicate commands")
  }
  return companions
}

export function parseSourceMetadata(value, label = "convax-package.json") {
  const required = ["schema", "kind", "id", "name", "description", "version", "license", "compatibility", "yanked"]
  exactKeys(value, [...required, "companions", "ownerPluginId", "showcase"], required, label)
  if (value.schema !== "convax.package/1") error(label, "unsupported schema")
  if (value.kind !== "plugin" && value.kind !== "skill") error(label, "kind must be plugin or skill")
  if (typeof value.yanked !== "boolean") error(label, "yanked must be a boolean")
  const kind = value.kind
  const id = parseId(value.id, `${label} id`)
  if (kind === "skill" && id.length > 64) error(label, "Skill id must be at most 64 characters")
  if (kind === "skill" && value.companions !== undefined) error(label, "companions are available only to Plugins")
  if (kind === "plugin" && value.ownerPluginId !== undefined) error(label, "ownerPluginId is available only to Skills")
  const ownerPluginId = value.ownerPluginId === undefined
    ? undefined
    : parseId(value.ownerPluginId, `${label} ownerPluginId`)
  const compatibility = parseCompatibility(value.compatibility, kind, `${label} compatibility`)
  const companions = parseSourceCompanions(value.companions, `${label} companions`)
  if (companions && compatibility.pluginSchema !== "convax.plugin/2" &&
      compatibility.pluginSchema !== "convax.plugin/3" && compatibility.pluginSchema !== "convax.plugin/4" &&
      compatibility.pluginSchema !== "convax.plugin/5") {
    error(label, "companions require convax.plugin/2 or later compatibility")
  }
  return {
    schema: "convax.package/1",
    kind,
    id,
    name: cleanString(value.name, `${label} name`, 120),
    description: cleanString(value.description, `${label} description`, 2000),
    version: parseSemver(value.version, `${label} version`),
    license: cleanString(value.license, `${label} license`, 120),
    compatibility,
    yanked: value.yanked,
    ...(companions === undefined ? {} : { companions }),
    ...(ownerPluginId === undefined ? {} : { ownerPluginId }),
    ...(value.showcase === undefined ? {} : { showcase: parseShowcaseSource(value.showcase, `${label} showcase`) }),
  }
}

function stringArray(value, label, validate) {
  if (value === undefined) return undefined
  if (!Array.isArray(value) || value.length > 64) error(label, "must be an array with at most 64 items")
  const result = value.map((item) => validate(cleanString(item, label, 128)))
  if (new Set(result).size !== result.length) error(label, "contains duplicate values")
  return result
}

function dimension(value, label) {
  if (value === undefined) return undefined
  if (!Number.isSafeInteger(value) || value < 1 || value > 8192) error(label, "must be an integer from 1 to 8192")
  return value
}

function parseRenderer(value, label) {
  exactKeys(value, ["create", "extensions", "height", "mimeTypes", "nodeKinds", "width"], [], label)
  if (value.create !== undefined && typeof value.create !== "boolean") error(label, "create must be a boolean")
  const extensions = stringArray(value.extensions, `${label} extensions`, (item) => {
    if (item !== item.toLowerCase() || !/^\.[a-z0-9][a-z0-9._+-]{0,31}$/.test(item)) error(label, `invalid extension ${item}`)
    return item
  })
  const mimeTypes = stringArray(value.mimeTypes, `${label} mimeTypes`, (item) => {
    if (item !== item.toLowerCase() || !/^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/.test(item)) error(label, `invalid MIME type ${item}`)
    return item
  })
  const nodeKinds = stringArray(value.nodeKinds, `${label} nodeKinds`, (item) => {
    if (!/^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/.test(item)) error(label, `invalid node kind ${item}`)
    return item
  })
  if (value.create !== true && !extensions?.length && !mimeTypes?.length && !nodeKinds?.length) {
    error(label, "must be creatable or match an extension, MIME type, or node kind")
  }
  return {
    ...(value.create === undefined ? {} : { create: value.create }),
    ...(extensions === undefined ? {} : { extensions }),
    ...(value.height === undefined ? {} : { height: dimension(value.height, `${label} height`) }),
    ...(mimeTypes === undefined ? {} : { mimeTypes }),
    ...(nodeKinds === undefined ? {} : { nodeKinds }),
    ...(value.width === undefined ? {} : { width: dimension(value.width, `${label} width`) }),
  }
}

function parseToolbar(value, label) {
  if (value === undefined) return undefined
  if (!Array.isArray(value) || value.length > 32) error(label, "must be an array with at most 32 items")
  const result = value.map((item, index) => {
    const itemLabel = `${label} item ${index}`
    exactKeys(item, ["command", "id", "title"], ["command", "id", "title"], itemLabel)
    const id = cleanString(item.id, `${itemLabel} id`, 80)
    if (!/^[a-z0-9]+(?:[._-][a-z0-9]+)*$/.test(id)) error(itemLabel, "invalid id")
    return {
      command: cleanString(item.command, `${itemLabel} command`, 256),
      id,
      title: cleanString(item.title, `${itemLabel} title`, 120),
    }
  })
  if (new Set(result.map((item) => item.id)).size !== result.length) error(label, "contains duplicate ids")
  return result
}

function parseLegacyPluginManifest(value, label) {
  if (!isObject(value) || (value.schema !== "convax.plugin/1" && value.schema !== "convax.plugin/2")) {
    error(label, "unsupported schema")
  }
  const v2 = value.schema === "convax.plugin/2"
  const required = ["contributes", "description", "id", "name", "schema", "version"]
  exactKeys(value,
    ["capabilities", "contributes", "description", "entry", "id", "name", ...(v2 ? ["runtime"] : []), "schema", "skill", "version"],
    [...required, ...(v2 ? [] : ["capabilities", "entry"])], label)

  const capabilities = value.capabilities ?? []
  if (!Array.isArray(capabilities) || capabilities.length > pluginCapabilities.size ||
      capabilities.some((item) => typeof item !== "string" || !pluginCapabilities.has(item)) ||
      new Set(capabilities).size !== capabilities.length) error(label, "invalid or duplicate capability")
  if (capabilities.some((capability) => pluginV5Capabilities.has(capability))) {
    error(label, "Project-wide Canvas capabilities are available only to convax.plugin/5")
  }
  if (!v2 && capabilities.includes("generation.execute")) {
    error(label, "generation.execute is available only to convax.plugin/2")
  }

  exactKeys(value.contributes, ["canvas", ...(v2 ? ["generation", "service"] : [])], v2 ? [] : ["canvas"], `${label} contributes`)
  const hasEntry = value.entry !== undefined
  const hasCanvas = value.contributes.canvas !== undefined
  if (hasEntry !== hasCanvas) error(label, "entry and Canvas contribution must appear together")
  if (!v2 && !hasCanvas) error(label, "convax.plugin/1 requires a static Canvas surface")
  if (capabilities.includes("generation.execute") && !hasCanvas) {
    error(label, "generation.execute requires a sandboxed Canvas surface")
  }

  let entry
  let canvas
  if (hasEntry) {
    entry = parseRelativePath(value.entry, `${label} entry`)
    if (!entry.toLowerCase().endsWith(".html")) error(label, "entry must be an HTML file")
    exactKeys(value.contributes.canvas, ["renderer", "toolbar"], ["renderer"], `${label} canvas`)
    const toolbar = parseToolbar(value.contributes.canvas.toolbar, `${label} toolbar`)
    canvas = {
      renderer: parseRenderer(value.contributes.canvas.renderer, `${label} renderer`),
      ...(toolbar === undefined ? {} : { toolbar }),
    }
  }

  const hasRuntime = value.runtime !== undefined
  const hasGeneration = value.contributes.generation !== undefined
  const hasService = value.contributes.service !== undefined
  const hasExecutableContribution = hasGeneration || hasService
  if (v2 && hasRuntime !== hasExecutableContribution) {
    error(label, "runtime and executable contribution must appear together")
  }
  if (v2 && !hasRuntime && !capabilities.includes("generation.execute")) {
    error(label, "convax.plugin/2 must declare an executable contribution or request generation.execute")
  }
  const generation = hasGeneration ? parseGeneration(value.contributes.generation, `${label} generation`) : undefined
  const service = hasService ? parseService(value.contributes.service, `${label} service`) : undefined
  const runtime = hasRuntime ? parseMcpStdioRuntime(value.runtime, `${label} runtime`) : undefined

  return {
    capabilities: [...capabilities],
    contributes: {
      ...(canvas === undefined ? {} : { canvas }),
      ...(generation === undefined ? {} : { generation }),
      ...(service === undefined ? {} : { service }),
    },
    description: cleanString(value.description, `${label} description`, 2000),
    ...(entry === undefined ? {} : { entry }),
    id: parseId(value.id, `${label} id`),
    name: cleanString(value.name, `${label} name`, 120),
    schema: value.schema,
    ...(value.skill === undefined ? {} : { skill: parseRelativePath(value.skill, `${label} skill`) }),
    ...(runtime === undefined ? {} : { runtime }),
    version: parseSemver(value.version, `${label} version`),
  }
}

const selectionActionEditors = new Set(["time-point", "time-range", "crop-region", "confirmation"])

function parsePluginReferenceId(value, label) {
  const id = cleanString(value, label, 80)
  if (!/^[a-z0-9]+(?:[._-][a-z0-9]+)*$/.test(id)) error(label, "invalid id")
  return id
}

function parseLocalizedText(value, label, maxLength) {
  exactKeys(value, ["default", "zh-CN"], ["default"], label)
  return {
    default: cleanString(value.default, `${label} default`, maxLength),
    ...(value["zh-CN"] === undefined
      ? {}
      : { "zh-CN": cleanString(value["zh-CN"], `${label} zh-CN`, maxLength) }),
  }
}

function parseGenerationV3(value, label) {
  exactKeys(value, ["models", "tools"], ["models", "tools"], label)
  const { tools } = parseGeneration({ tools: value.tools }, label)
  if (!Array.isArray(value.models) || value.models.length > 64) {
    error(label, "models must be an array with at most 64 items")
  }
  const models = value.models.map((item, index) => {
    const itemLabel = `${label} model ${index}`
    exactKeys(item, ["name", "tool"], ["name", "tool"], itemLabel)
    return {
      name: cleanString(item.name, `${itemLabel} name`, 120),
      tool: parsePluginReferenceId(item.tool, `${itemLabel} tool`),
    }
  })
  if (new Set(models.map((model) => model.name)).size !== models.length) {
    error(label, "models contain duplicate names")
  }
  if (new Set(models.map((model) => model.tool)).size !== models.length) {
    error(label, "models contain duplicate tool references")
  }
  const toolIds = new Set(tools.map((tool) => tool.id))
  const missing = models.find((model) => !toolIds.has(model.tool))
  if (missing) error(label, `model ${missing.name} references unknown generation tool ${missing.tool}`)
  return { models, tools }
}

function parseAgentV3(value, generation, label) {
  exactKeys(value, ["tools"], ["tools"], label)
  if (!Array.isArray(value.tools) || value.tools.length < 1 || value.tools.length > 32) {
    error(label, "tools must be a non-empty array with at most 32 items")
  }
  const tools = value.tools.map((item, index) => {
    const itemLabel = `${label} tool ${index}`
    exactKeys(item, ["id", "tool"], ["id", "tool"], itemLabel)
    return {
      id: cleanString(item.id, `${itemLabel} id`, 64),
      tool: parsePluginReferenceId(item.tool, `${itemLabel} tool`),
    }
  })
  const invalidId = tools.find((tool) => !/^[a-z][a-z0-9_]{0,63}$/.test(tool.id))
  if (invalidId) error(label, `agent tool id ${invalidId.id} must use lowercase letters, digits, and underscores`)
  if (new Set(tools.map((tool) => tool.id)).size !== tools.length) error(label, "tools contain duplicate ids")
  if (new Set(tools.map((tool) => tool.tool)).size !== tools.length) {
    error(label, "tools contain duplicate generation tool references")
  }
  const generationToolIds = new Set(generation.tools.map((tool) => tool.id))
  const modelToolIds = new Set(generation.models.map((model) => model.tool))
  const missing = tools.find((tool) => !generationToolIds.has(tool.tool))
  if (missing) error(label, `agent tool ${missing.id} references unknown generation tool ${missing.tool}`)
  const model = tools.find((tool) => modelToolIds.has(tool.tool))
  if (model) error(label, `agent tool ${model.id} must reference a non-model generation tool`)
  return { tools }
}

function parseSelectionActionsV3(value, generation, label) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 32) {
    error(label, "must be a non-empty array with at most 32 items")
  }
  const actions = value.map((item, index) => {
    const itemLabel = `${label} item ${index}`
    exactKeys(item, ["description", "editor", "id", "steps", "target", "title"],
      ["description", "editor", "id", "steps", "target", "title"], itemLabel)
    if (item.target !== "video") error(itemLabel, "target must be video")
    if (!selectionActionEditors.has(item.editor)) error(itemLabel, "unsupported editor")
    if (!Array.isArray(item.steps) || item.steps.length < 1 || item.steps.length > 16) {
      error(itemLabel, "steps must be a non-empty array with at most 16 items")
    }
    if (item.editor !== "confirmation" && item.steps.length !== 1) {
      error(itemLabel, "non-confirmation editors require exactly one step")
    }
    const steps = item.steps.map((step, stepIndex) => {
      const stepLabel = `${itemLabel} step ${stepIndex}`
      exactKeys(step, ["tool"], ["tool"], stepLabel)
      return { tool: parsePluginReferenceId(step.tool, `${stepLabel} tool`) }
    })
    if (new Set(steps.map((step) => step.tool)).size !== steps.length) {
      error(itemLabel, "steps contain duplicate tool references")
    }
    const generationTools = new Map(generation.tools.map((tool) => [tool.id, tool]))
    const modelToolIds = new Set(generation.models.map((model) => model.tool))
    const missing = steps.find((step) => !generationTools.has(step.tool))
    if (missing) error(itemLabel, `references unknown generation tool ${missing.tool}`)
    const model = steps.find((step) => modelToolIds.has(step.tool))
    if (model) error(itemLabel, `must reference a non-model generation tool, not ${model.tool}`)
    const incompatible = steps.find((step) => !generationTools.get(step.tool).acceptedInputs.includes("reference_video"))
    if (incompatible) error(itemLabel, `tool ${incompatible.tool} must accept reference_video`)
    return {
      description: parseLocalizedText(item.description, `${itemLabel} description`, 2000),
      editor: item.editor,
      id: parsePluginReferenceId(item.id, `${itemLabel} id`),
      steps,
      target: "video",
      title: parseLocalizedText(item.title, `${itemLabel} title`, 120),
    }
  })
  if (new Set(actions.map((action) => action.id)).size !== actions.length) error(label, "contains duplicate ids")
  return actions
}

function parseCanvasV3(value, generation, label) {
  exactKeys(value, ["renderer", "selectionActions", "toolbar"], [], label)
  if (value.toolbar !== undefined && value.renderer === undefined) {
    error(label, "toolbar requires a renderer")
  }
  if (value.renderer === undefined && value.selectionActions === undefined) {
    error(label, "must declare a renderer or selectionActions")
  }
  const renderer = value.renderer === undefined ? undefined : parseRenderer(value.renderer, `${label} renderer`)
  const selectionActions = value.selectionActions === undefined
    ? undefined
    : parseSelectionActionsV3(value.selectionActions, generation, `${label} selectionActions`)
  const toolbar = parseToolbar(value.toolbar, `${label} toolbar`)
  return {
    ...(renderer === undefined ? {} : { renderer }),
    ...(selectionActions === undefined ? {} : { selectionActions }),
    ...(toolbar === undefined ? {} : { toolbar }),
  }
}

function parsePluginManifestV3(value, label) {
  const required = ["contributes", "description", "id", "name", "schema", "version"]
  exactKeys(value,
    ["capabilities", "contributes", "description", "entry", "id", "name", "runtime", "schema", "skill", "version"],
    required, label)
  exactKeys(value.contributes, ["agent", "canvas", "generation", "service"], [], `${label} contributes`)

  const capabilities = value.capabilities ?? []
  if (!Array.isArray(capabilities) || capabilities.length > pluginCapabilities.size ||
      capabilities.some((item) => typeof item !== "string" || !pluginCapabilities.has(item)) ||
      new Set(capabilities).size !== capabilities.length) error(label, "invalid or duplicate capability")
  if (capabilities.some((capability) => pluginV5Capabilities.has(capability))) {
    error(label, "Project-wide Canvas capabilities are available only to convax.plugin/5")
  }

  const hasRuntime = value.runtime !== undefined
  const hasGeneration = value.contributes.generation !== undefined
  const hasService = value.contributes.service !== undefined
  if (hasRuntime !== (hasGeneration || hasService)) {
    error(label, "runtime and executable contribution must appear together")
  }
  if (!hasRuntime && !capabilities.includes("generation.execute")) {
    error(label, "convax.plugin/3 must declare an executable contribution or request generation.execute")
  }

  const generation = hasGeneration ? parseGenerationV3(value.contributes.generation, `${label} generation`) : undefined
  if (value.contributes.agent !== undefined && generation === undefined) {
    error(label, "agent tools require a generation contribution")
  }
  const agent = value.contributes.agent === undefined
    ? undefined
    : parseAgentV3(value.contributes.agent, generation, `${label} agent`)

  const hasCanvas = value.contributes.canvas !== undefined
  if (hasCanvas && value.contributes.canvas.selectionActions !== undefined && generation === undefined) {
    error(label, "selectionActions require a generation contribution")
  }
  const canvas = hasCanvas
    ? parseCanvasV3(value.contributes.canvas, generation, `${label} canvas`)
    : undefined
  const hasRenderer = canvas?.renderer !== undefined
  const hasEntry = value.entry !== undefined
  if (hasEntry !== hasRenderer) error(label, "entry and Canvas renderer must appear together")
  if (capabilities.includes("generation.execute") && !hasRenderer) {
    error(label, "generation.execute requires a sandboxed Canvas renderer")
  }

  let entry
  if (hasEntry) {
    entry = parseRelativePath(value.entry, `${label} entry`)
    if (!entry.toLowerCase().endsWith(".html")) error(label, "entry must be an HTML file")
  }

  const service = hasService ? parseService(value.contributes.service, `${label} service`) : undefined
  const runtime = hasRuntime ? parseMcpStdioRuntime(value.runtime, `${label} runtime`) : undefined
  return {
    capabilities: [...capabilities],
    contributes: {
      ...(agent === undefined ? {} : { agent }),
      ...(canvas === undefined ? {} : { canvas }),
      ...(generation === undefined ? {} : { generation }),
      ...(service === undefined ? {} : { service }),
    },
    description: cleanString(value.description, `${label} description`, 2000),
    ...(entry === undefined ? {} : { entry }),
    id: parseId(value.id, `${label} id`),
    name: cleanString(value.name, `${label} name`, 120),
    schema: "convax.plugin/3",
    ...(value.skill === undefined ? {} : { skill: parseRelativePath(value.skill, `${label} skill`) }),
    ...(runtime === undefined ? {} : { runtime }),
    version: parseSemver(value.version, `${label} version`),
  }
}

function parseOwnedSkillsV4(value, label) {
  if (value === undefined) return undefined
  if (!Array.isArray(value) || value.length < 1 || value.length > 32) {
    error(label, "must be a non-empty array with at most 32 items")
  }
  const skills = value.map((item, index) => {
    const itemLabel = `${label} item ${index}`
    exactKeys(item, ["name", "path"], ["name", "path"], itemLabel)
    const name = parseId(item.name, `${itemLabel} name`)
    if (name.length > 64) error(itemLabel, "name must be at most 64 characters")
    const skillPath = parseRelativePath(item.path, `${itemLabel} path`)
    if (skillPath !== `skills/${name}`) error(itemLabel, `path must equal skills/${name}`)
    return { name, path: skillPath }
  })
  if (new Set(skills.map((skill) => skill.name)).size !== skills.length) {
    error(label, "contains duplicate names")
  }
  if (new Set(skills.map((skill) => skill.path)).size !== skills.length) {
    error(label, "contains duplicate paths")
  }
  return skills
}

function parsePluginManifestV4(value, label) {
  const required = ["contributes", "description", "id", "name", "schema", "version"]
  exactKeys(value,
    ["capabilities", "contributes", "description", "entry", "id", "name", "runtime", "schema", "version"],
    required, label)
  exactKeys(value.contributes, ["agent", "canvas", "generation", "service", "skills"], [], `${label} contributes`)

  const capabilities = value.capabilities ?? []
  if (!Array.isArray(capabilities) || capabilities.length > pluginCapabilities.size ||
      capabilities.some((item) => typeof item !== "string" || !pluginCapabilities.has(item)) ||
      new Set(capabilities).size !== capabilities.length) error(label, "invalid or duplicate capability")
  if (capabilities.some((capability) => pluginV5Capabilities.has(capability))) {
    error(label, "Project-wide Canvas capabilities are available only to convax.plugin/5")
  }

  const hasRuntime = value.runtime !== undefined
  const hasGeneration = value.contributes.generation !== undefined
  const hasService = value.contributes.service !== undefined
  if (hasRuntime !== (hasGeneration || hasService)) {
    error(label, "runtime and executable contribution must appear together")
  }

  const generation = hasGeneration ? parseGenerationV3(value.contributes.generation, `${label} generation`) : undefined
  if (value.contributes.agent !== undefined && generation === undefined) {
    error(label, "agent tools require a generation contribution")
  }
  const agent = value.contributes.agent === undefined
    ? undefined
    : parseAgentV3(value.contributes.agent, generation, `${label} agent`)

  const hasCanvas = value.contributes.canvas !== undefined
  if (hasCanvas && value.contributes.canvas.selectionActions !== undefined && generation === undefined) {
    error(label, "selectionActions require a generation contribution")
  }
  const canvas = hasCanvas
    ? parseCanvasV3(value.contributes.canvas, generation, `${label} canvas`)
    : undefined
  const hasRenderer = canvas?.renderer !== undefined
  if (!hasRuntime && !hasRenderer && !capabilities.includes("generation.execute")) {
    error(label, "convax.plugin/4 must declare a Plugin capability beyond owned Skills")
  }
  const hasEntry = value.entry !== undefined
  if (hasEntry !== hasRenderer) error(label, "entry and Canvas renderer must appear together")
  if (capabilities.includes("generation.execute") && !hasRenderer) {
    error(label, "generation.execute requires a sandboxed Canvas renderer")
  }

  let entry
  if (hasEntry) {
    entry = parseRelativePath(value.entry, `${label} entry`)
    if (!entry.toLowerCase().endsWith(".html")) error(label, "entry must be an HTML file")
  }

  const service = hasService ? parseService(value.contributes.service, `${label} service`) : undefined
  const skills = parseOwnedSkillsV4(value.contributes.skills, `${label} skills`)
  const runtime = hasRuntime ? parseMcpStdioRuntime(value.runtime, `${label} runtime`) : undefined
  return {
    capabilities: [...capabilities],
    contributes: {
      ...(agent === undefined ? {} : { agent }),
      ...(canvas === undefined ? {} : { canvas }),
      ...(generation === undefined ? {} : { generation }),
      ...(service === undefined ? {} : { service }),
      ...(skills === undefined ? {} : { skills }),
    },
    description: cleanString(value.description, `${label} description`, 2000),
    ...(entry === undefined ? {} : { entry }),
    id: parseId(value.id, `${label} id`),
    name: cleanString(value.name, `${label} name`, 120),
    schema: "convax.plugin/4",
    ...(runtime === undefined ? {} : { runtime }),
    version: parseSemver(value.version, `${label} version`),
  }
}

function parseLlmV5(value, label) {
  exactKeys(value, ["models", "provider"], ["models", "provider"], label)
  exactKeys(value.provider, ["id", "name"], ["id", "name"], `${label} provider`)
  const providerId = parseId(value.provider.id, `${label} provider id`)
  if (!Array.isArray(value.models) || value.models.length < 1 || value.models.length > 32) {
    error(label, "models must be a non-empty array with at most 32 items")
  }
  const models = value.models.map((item, index) => {
    const itemLabel = `${label} model ${index}`
    exactKeys(item, ["id", "name"], ["id", "name"], itemLabel)
    const id = cleanString(item.id, `${itemLabel} id`, 128)
    if (!/^[a-z0-9]+(?:[._-][a-z0-9]+)*$/.test(id)) error(itemLabel, "invalid id")
    return { id, name: cleanString(item.name, `${itemLabel} name`, 120) }
  })
  if (new Set(models.map((model) => model.id)).size !== models.length) error(label, "models contain duplicate ids")
  return {
    models,
    provider: { id: providerId, name: cleanString(value.provider.name, `${label} provider name`, 120) },
  }
}

function parsePetV5(value, label) {
  exactKeys(value, ["library", "overlay", "protocol", "settings"], ["library", "overlay", "protocol", "settings"], label)
  const library = parseRelativePath(value.library, `${label} library`)
  const overlay = parseRelativePath(value.overlay, `${label} overlay`)
  const settings = parseRelativePath(value.settings, `${label} settings`)
  if (!library.toLowerCase().endsWith(".json")) error(label, "library must be a JSON file")
  if (!overlay.toLowerCase().endsWith(".html")) error(label, "overlay must be an HTML file")
  if (!settings.toLowerCase().endsWith(".html")) error(label, "settings must be an HTML file")
  if (value.protocol !== "convax.pet-host/1") error(label, "protocol must equal convax.pet-host/1")
  return { library, overlay, protocol: "convax.pet-host/1", settings }
}

function parsePluginManifestV5(value, label) {
  const required = ["contributes", "description", "id", "name", "schema", "version"]
  exactKeys(
    value,
    ["capabilities", "contributes", "description", "entry", "id", "name", "runtime", "schema", "version"],
    required,
    label,
  )
  exactKeys(
    value.contributes,
    ["agent", "canvas", "generation", "llm", "pet", "service", "skills"],
    [],
    `${label} contributes`,
  )

  const capabilities = value.capabilities ?? []
  if (!Array.isArray(capabilities) || capabilities.length > pluginCapabilities.size ||
      capabilities.some((item) => typeof item !== "string" || !pluginCapabilities.has(item)) ||
      new Set(capabilities).size !== capabilities.length) error(label, "invalid or duplicate capability")

  const hasGeneration = value.contributes.generation !== undefined
  const hasService = value.contributes.service !== undefined
  const hasLlm = value.contributes.llm !== undefined
  const hasRuntime = value.runtime !== undefined
  if (hasRuntime !== (hasGeneration || hasService || hasLlm)) {
    error(label, "runtime and executable contribution must appear together")
  }

  const generation = hasGeneration ? parseGenerationV3(value.contributes.generation, `${label} generation`) : undefined
  if (value.contributes.agent !== undefined && generation === undefined) {
    error(label, "agent tools require a generation contribution")
  }
  const agent = value.contributes.agent === undefined
    ? undefined
    : parseAgentV3(value.contributes.agent, generation, `${label} agent`)

  const hasCanvas = value.contributes.canvas !== undefined
  if (hasCanvas && value.contributes.canvas.selectionActions !== undefined && generation === undefined) {
    error(label, "selectionActions require a generation contribution")
  }
  const canvas = hasCanvas
    ? parseCanvasV3(value.contributes.canvas, generation, `${label} canvas`)
    : undefined
  const hasRenderer = canvas?.renderer !== undefined
  const hasEntry = value.entry !== undefined
  if (hasEntry !== hasRenderer) error(label, "entry and Canvas renderer must appear together")
  if (capabilities.includes("generation.execute") && !hasRenderer) {
    error(label, "generation.execute requires a sandboxed Canvas renderer")
  }

  const skills = parseOwnedSkillsV4(value.contributes.skills, `${label} skills`)
  const pet = value.contributes.pet === undefined
    ? undefined
    : parsePetV5(value.contributes.pet, `${label} pet`)
  if (pet !== undefined) {
    const requiredPetCapabilities = ["pet.activity.read", "pet.activity.open", "pet.preferences.write"]
    if (capabilities.length !== requiredPetCapabilities.length ||
        requiredPetCapabilities.some((capability) => !capabilities.includes(capability))) {
      error(label, "pet capabilities must be exactly pet.activity.read, pet.activity.open, and pet.preferences.write")
    }
    if (hasRuntime) error(label, "pet feature cannot declare an executable runtime")
  }
  const hasProjectCapability = capabilities.some((capability) => pluginV5Capabilities.has(capability))
  if (!hasRuntime && !hasRenderer && !canvas?.selectionActions?.length &&
      !capabilities.includes("generation.execute") && !hasProjectCapability && pet === undefined) {
    error(label, "convax.plugin/5 must declare a Plugin capability beyond owned Skills")
  }

  let entry
  if (hasEntry) {
    entry = parseRelativePath(value.entry, `${label} entry`)
    if (!entry.toLowerCase().endsWith(".html")) error(label, "entry must be an HTML file")
  }
  const llm = hasLlm ? parseLlmV5(value.contributes.llm, `${label} llm`) : undefined
  const service = hasService ? parseService(value.contributes.service, `${label} service`) : undefined
  const runtime = hasRuntime ? parseMcpStdioRuntime(value.runtime, `${label} runtime`) : undefined
  return {
    capabilities: [...capabilities],
    contributes: {
      ...(agent === undefined ? {} : { agent }),
      ...(canvas === undefined ? {} : { canvas }),
      ...(generation === undefined ? {} : { generation }),
      ...(llm === undefined ? {} : { llm }),
      ...(pet === undefined ? {} : { pet }),
      ...(service === undefined ? {} : { service }),
      ...(skills === undefined ? {} : { skills }),
    },
    description: cleanString(value.description, `${label} description`, 2_000),
    ...(entry === undefined ? {} : { entry }),
    id: parseId(value.id, `${label} id`),
    name: cleanString(value.name, `${label} name`, 120),
    schema: "convax.plugin/5",
    ...(runtime === undefined ? {} : { runtime }),
    version: parseSemver(value.version, `${label} version`),
  }
}

export function parsePluginManifest(value, label = "manifest.json") {
  if (!isObject(value) ||
      (value.schema !== "convax.plugin/1" && value.schema !== "convax.plugin/2" &&
       value.schema !== "convax.plugin/3" && value.schema !== "convax.plugin/4" &&
       value.schema !== "convax.plugin/5")) {
    error(label, "unsupported schema")
  }
  if (value.schema === "convax.plugin/5") return parsePluginManifestV5(value, label)
  if (value.schema === "convax.plugin/4") return parsePluginManifestV4(value, label)
  if (value.schema === "convax.plugin/3") return parsePluginManifestV3(value, label)
  return parseLegacyPluginManifest(value, label)
}

const serviceActions = new Set(["authorize", "reauthorize", "authorization.cancel", "sign_out"])

function parseService(value, label) {
  exactKeys(value, ["actions"], ["actions"], label)
  if (!Array.isArray(value.actions) || value.actions.length > serviceActions.size ||
      value.actions.some((action) => typeof action !== "string" || !serviceActions.has(action)) ||
      new Set(value.actions).size !== value.actions.length) {
    error(label, "actions contains an unsupported or duplicate fixed host action")
  }
  return { actions: [...value.actions] }
}

function parseMcpStdioRuntime(value, label) {
  exactKeys(value, ["args", "command", "type"], ["command", "type"], label)
  if (value.type !== "mcp-stdio") error(label, "type must be mcp-stdio")
  const command = cleanString(value.command, `${label} command`, 128)
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(command)) error(label, "command must be a bare executable name")
  validatePortableSegment(command, `${label} command`)
  let args
  if (value.args !== undefined) {
    if (!Array.isArray(value.args) || value.args.length > 64) error(label, "args must contain at most 64 items")
    args = value.args.map((item, index) => {
      const argument = cleanString(item, `${label} arg ${index}`, 1024)
      if (/[\s"'`;|&`$(){}[\]<>]/.test(argument) || argument.includes("\\") ||
          /(^|=)(?:\/|[A-Za-z]:)/.test(argument) || /(^|[=/])\.{1,2}(?:\/|$)/.test(argument)) {
        error(label, `arg ${index} must be a static CLI token without code, native paths, or traversal`)
      }
      return argument
    })
  }
  return { ...(args === undefined ? {} : { args }), command, type: "mcp-stdio" }
}

function parseGeneration(value, label) {
  exactKeys(value, ["tools"], ["tools"], label)
  if (!Array.isArray(value.tools) || value.tools.length < 1 || value.tools.length > 64) {
    error(label, "tools must be a non-empty array with at most 64 items")
  }
  const tools = value.tools.map((item, index) => {
    const itemLabel = `${label} tool ${index}`
    exactKeys(item, ["acceptedInputs", "description", "id", "output", "title"],
      ["acceptedInputs", "description", "id", "output", "title"], itemLabel)
    const id = cleanString(item.id, `${itemLabel} id`, 80)
    if (!/^[a-z0-9]+(?:[._-][a-z0-9]+)*$/.test(id)) error(itemLabel, "invalid id")
    if (!generationModalities.has(item.output)) error(itemLabel, "unsupported output")
    if (!Array.isArray(item.acceptedInputs) || item.acceptedInputs.length > generationInputRoles.size ||
        item.acceptedInputs.some((role) => typeof role !== "string" || !generationInputRoles.has(role)) ||
        new Set(item.acceptedInputs).size !== item.acceptedInputs.length) {
      error(itemLabel, "acceptedInputs contains an unsupported or duplicate role")
    }
    return {
      acceptedInputs: [...item.acceptedInputs],
      description: cleanString(item.description, `${itemLabel} description`, 2000),
      id,
      output: item.output,
      title: cleanString(item.title, `${itemLabel} title`, 120),
    }
  })
  if (new Set(tools.map((tool) => tool.id)).size !== tools.length) error(label, "tools contain duplicate ids")
  return { tools }
}

export function parseSkill(markdown, expectedName, label = "SKILL.md") {
  if (typeof markdown !== "string" || !markdown.startsWith("---\n")) error(label, "must start with YAML frontmatter")
  const end = markdown.indexOf("\n---\n", 4)
  if (end < 0) error(label, "frontmatter must end with ---")
  const fields = new Map()
  for (const line of markdown.slice(4, end).split("\n")) {
    const match = /^([a-zA-Z][a-zA-Z0-9_-]*):\s+(.+)$/.exec(line)
    if (!match) error(label, `unsupported frontmatter line ${line}`)
    if (fields.has(match[1])) error(label, `duplicate frontmatter field ${match[1]}`)
    fields.set(match[1], match[2])
  }
  const name = parseId(fields.get("name"), `${label} name`)
  cleanString(fields.get("description"), `${label} description`, 1024)
  if (expectedName && name !== expectedName) error(label, `name must equal ${expectedName}`)
  if (markdown.slice(end + 5).trim().length === 0) error(label, "must contain instructions")
  return { name }
}

export async function readJson(file, label = file) {
  let text
  try { text = await fs.readFile(file, "utf8") } catch (cause) { throw new Error(`${label}: cannot read`, { cause }) }
  try { return JSON.parse(text) } catch (cause) { throw new Error(`${label}: invalid JSON`, { cause }) }
}

export async function collectFiles(directory, label = directory) {
  const files = []
  const seen = new Map()
  let total = 0
  async function visit(current, relativeDirectory = "") {
    const entries = await fs.readdir(current, { withFileTypes: true })
    for (const entry of entries) {
      validatePortableSegment(entry.name, `${label} path`)
      const relativePath = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name
      parseRelativePath(relativePath, `${label} path`)
      const folded = relativePath.normalize("NFC").toLowerCase()
      const previous = seen.get(folded)
      if (previous) error(label, `portable path collision between ${previous} and ${relativePath}`)
      seen.set(folded, relativePath)
      const absolutePath = path.join(current, entry.name)
      if (entry.isSymbolicLink()) error(label, `symlink is forbidden: ${relativePath}`)
      if (entry.isDirectory()) { await visit(absolutePath, relativePath); continue }
      if (!entry.isFile()) error(label, `unsupported filesystem entry: ${relativePath}`)
      const stat = await fs.stat(absolutePath)
      if (stat.size > maxFileBytes) error(label, `file exceeds 2 MiB: ${relativePath}`)
      total += stat.size
      if (total > maxPackageBytes) error(label, "package exceeds 10 MiB")
      const data = await fs.readFile(absolutePath)
      files.push({ absolutePath, data, mode: stat.mode, relativePath })
    }
  }
  await visit(directory)
  files.sort((left, right) => Buffer.compare(Buffer.from(left.relativePath), Buffer.from(right.relativePath)))
  return files
}

function packageEntryCount(files) {
  const entries = new Set()
  for (const file of files) {
    const segments = file.relativePath.split("/")
    for (let index = 1; index <= segments.length; index += 1) {
      entries.add(segments.slice(0, index).join("/").normalize("NFC").toLowerCase())
    }
  }
  return entries.size
}

function assertPackageInventory(files, kind, label) {
  const totalBytes = files.reduce((total, file) => total + file.data.byteLength, 0)
  if (totalBytes > maxPackageBytes) error(label, "package exceeds 10 MiB")
  const maximumEntries = kind === "plugin" ? maxPluginEntries : maxSkillEntries
  if (packageEntryCount(files) > maximumEntries) {
    error(label, `package exceeds the ${maximumEntries} entry limit`)
  }
}

export function assertPluginStatic(files, label) {
  for (const file of files) {
    const extension = path.posix.extname(file.relativePath).toLowerCase()
    if ((file.mode & 0o111) !== 0) error(label, `executable file mode is forbidden: ${file.relativePath}`)
    if (nativeExtensions.has(extension)) error(label, `executable file type is forbidden: ${file.relativePath}`)
    if (pluginExecutableSourceExtensions.has(extension)) {
      error(label, `executable or server source is forbidden: ${file.relativePath}`)
    }
    if ([".html", ".css", ".js", ".mjs", ".cjs"].includes(extension)) {
      const text = file.data.toString("utf8")
      if (/https?:\/\//i.test(text) || /\b(?:fetch|WebSocket|XMLHttpRequest|EventSource)\s*\(/.test(text) ||
          /navigator\.sendBeacon\s*\(/.test(text)) error(label, `remote runtime dependency is forbidden: ${file.relativePath}`)
      if (text.startsWith("#!") || extension === ".cjs" ||
          /(?:\bfrom\s*|\bimport\s*(?:\(|(?=["']))|\brequire\s*\()\s*["'](?:node:)?(?:child_process|cluster|fs|http|https|net|tls|worker_threads)\b/.test(text) ||
          /\b(?:createServer|spawn|execFile|fork)\s*\(/.test(text)) {
        error(label, `Node or executable runtime is forbidden: ${file.relativePath}`)
      }
    }
  }
}

async function listCollection(kind, workspaceRoot = root) {
  const collection = path.join(workspaceRoot, "packages", `${kind}s`)
  let entries
  try { entries = await fs.readdir(collection, { withFileTypes: true }) } catch (cause) {
    if (cause?.code === "ENOENT") return []
    throw cause
  }
  return entries.filter((entry) => entry.isDirectory()).map((entry) => ({ kind, id: entry.name, directory: path.join(collection, entry.name) }))
}

async function validatePackageWorkspace(candidate, metadata) {
  const label = `${candidate.kind}/${candidate.id} package.json`
  const packageJson = await readJson(path.join(candidate.directory, "package.json"), label)
  if (!isObject(packageJson)) error(label, "must be an object")
  const expectedName = `@microvoid/convax-${candidate.kind}-${candidate.id}`
  if (packageJson.name !== expectedName) error(label, `name must equal ${expectedName}`)
  if (packageJson.version !== metadata.version) error(label, "version must equal convax-package.json")
  if (packageJson.private !== true) error(label, "private must be true")
  if (packageJson.type !== "module") error(label, "type must be module")
  if (!isObject(packageJson.scripts) || typeof packageJson.scripts.validate !== "string" ||
      typeof packageJson.scripts.pack !== "string") {
    error(label, "scripts must declare validate and pack")
  }
  return packageJson
}

function pngDimensions(data, label) {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  if (data.length < 24 || !data.subarray(0, 8).equals(signature) || data.toString("ascii", 12, 16) !== "IHDR") {
    error(label, "content is not a PNG image")
  }
  return { width: data.readUInt32BE(16), height: data.readUInt32BE(20) }
}

function gifDimensions(data, label) {
  const signature = data.toString("ascii", 0, 6)
  if (data.length < 10 || (signature !== "GIF87a" && signature !== "GIF89a")) error(label, "content is not a GIF image")
  return { width: data.readUInt16LE(6), height: data.readUInt16LE(8) }
}

function jpegDimensions(data, label) {
  if (data.length < 4 || data[0] !== 0xff || data[1] !== 0xd8) error(label, "content is not a JPEG image")
  const sof = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf])
  let offset = 2
  while (offset + 4 <= data.length) {
    if (data[offset] !== 0xff) error(label, "JPEG contains an invalid marker")
    while (data[offset] === 0xff) offset += 1
    const marker = data[offset++]
    if (marker === 0xd9 || marker === 0xda) break
    const length = data.readUInt16BE(offset)
    if (length < 2 || offset + length > data.length) error(label, "JPEG contains an invalid segment")
    if (sof.has(marker)) {
      if (length < 7) error(label, "JPEG frame header is truncated")
      return { width: data.readUInt16BE(offset + 5), height: data.readUInt16BE(offset + 3) }
    }
    offset += length
  }
  error(label, "JPEG dimensions were not found")
}

function webpDimensions(data, label) {
  if (data.length < 30 || data.toString("ascii", 0, 4) !== "RIFF" || data.toString("ascii", 8, 12) !== "WEBP") {
    error(label, "content is not a WebP image")
  }
  const chunk = data.toString("ascii", 12, 16)
  if (chunk === "VP8X") {
    return {
      width: 1 + data.readUIntLE(24, 3),
      height: 1 + data.readUIntLE(27, 3),
    }
  }
  if (chunk === "VP8L" && data[20] === 0x2f) {
    const bits = data.readUInt32LE(21)
    return { width: 1 + (bits & 0x3fff), height: 1 + ((bits >>> 14) & 0x3fff) }
  }
  if (chunk === "VP8 " && data[23] === 0x9d && data[24] === 0x01 && data[25] === 0x2a) {
    return { width: data.readUInt16LE(26) & 0x3fff, height: data.readUInt16LE(28) & 0x3fff }
  }
  error(label, "unsupported or malformed WebP bitstream")
}

function parsePetLibrary(value, label) {
  exactKeys(value, ["pets", "schema"], ["pets", "schema"], label)
  if (value.schema !== "convax.pet-library/1") error(label, "schema must equal convax.pet-library/1")
  if (!Array.isArray(value.pets) || value.pets.length < 1 || value.pets.length > 64) {
    error(label, "pets must contain between 1 and 64 entries")
  }
  const pets = value.pets.map((item, index) => {
    const itemLabel = `${label} pets[${index}]`
    exactKeys(
      item,
      ["alt", "description", "displayName", "id", "spritesheet", "spriteVersion"],
      ["alt", "description", "displayName", "id", "spritesheet", "spriteVersion"],
      itemLabel,
    )
    const spritesheet = parseRelativePath(item.spritesheet, `${itemLabel} spritesheet`)
    if (!/\.(?:png|webp)$/i.test(spritesheet)) error(itemLabel, "spritesheet must be a PNG or WebP file")
    if (item.spriteVersion !== 2) error(itemLabel, "spriteVersion must equal 2")
    return {
      alt: cleanString(item.alt, `${itemLabel} alt`, 500),
      description: cleanString(item.description, `${itemLabel} description`, 2_000),
      displayName: cleanString(item.displayName, `${itemLabel} displayName`, 120),
      id: parseId(item.id, `${itemLabel} id`),
      spritesheet,
      spriteVersion: 2,
    }
  })
  if (new Set(pets.map((pet) => pet.id)).size !== pets.length) error(label, "pets contain duplicate ids")
  if (new Set(pets.map((pet) => pet.spritesheet.toLocaleLowerCase("en-US"))).size !== pets.length) {
    error(label, "pets contain duplicate spritesheet paths")
  }
  return { schema: "convax.pet-library/1", pets }
}

export function validatePetPackageLibrary(manifest, files, label = "Plugin") {
  const pet = manifest.contributes?.pet
  if (!pet) return undefined
  const entries = new Map(files.map((file) => [file.relativePath, file]))
  for (const [field, kind] of [["overlay", "overlay"], ["settings", "settings"]]) {
    if (!entries.has(pet[field])) error(label, `missing declared pet ${kind} ${pet[field]}`)
  }
  const libraryFile = entries.get(pet.library)
  if (!libraryFile) error(label, `missing declared pet library ${pet.library}`)
  let libraryValue
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(libraryFile.data)
    libraryValue = JSON.parse(text)
  } catch (cause) {
    throw new Error(`${label} pet library: invalid UTF-8 JSON`, { cause })
  }
  const library = parsePetLibrary(libraryValue, `${label} pet library`)
  for (const petEntry of library.pets) {
    const asset = entries.get(petEntry.spritesheet)
    if (!asset) error(label, `missing declared pet spritesheet ${petEntry.spritesheet}`)
    const extension = path.posix.extname(petEntry.spritesheet).toLowerCase()
    const dimensions = extension === ".png"
      ? pngDimensions(asset.data, `${label} pet spritesheet ${petEntry.id}`)
      : webpDimensions(asset.data, `${label} pet spritesheet ${petEntry.id}`)
    if (dimensions.width !== 1536 || dimensions.height !== 1872) {
      error(label, `pet spritesheet ${petEntry.id} must be exactly 1536 by 1872 pixels`)
    }
  }
  return library
}

function mp4Dimensions(data, label) {
  if (data.length < 24 || data.toString("ascii", 4, 8) !== "ftyp") error(label, "content is not an MP4 file")
  for (let offset = 4; offset + 4 <= data.length; offset += 1) {
    if (data.toString("ascii", offset, offset + 4) !== "tkhd" || offset < 4) continue
    const start = offset - 4
    const size = data.readUInt32BE(start)
    if (size < 84 || start + size > data.length) continue
    const widthFixed = data.readUInt32BE(start + size - 8)
    const heightFixed = data.readUInt32BE(start + size - 4)
    if ((widthFixed & 0xffff) !== 0 || (heightFixed & 0xffff) !== 0) error(label, "MP4 dimensions must use whole pixels")
    const width = widthFixed >>> 16
    const height = heightFixed >>> 16
    if (width > 0 && height > 0) return { width, height }
  }
  error(label, "MP4 video track dimensions were not found")
}

export function inspectShowcaseMedia(input, mime, label = "showcase media") {
  const data = Buffer.from(input)
  const result = mime === "image/png" ? pngDimensions(data, label)
    : mime === "image/gif" ? gifDimensions(data, label)
      : mime === "image/jpeg" ? jpegDimensions(data, label)
        : mime === "image/webp" ? webpDimensions(data, label)
          : mime === "video/mp4" ? mp4Dimensions(data, label)
            : error(label, `unsupported MIME type ${mime}`)
  if (!Number.isSafeInteger(result.width) || !Number.isSafeInteger(result.height) ||
      result.width < 1 || result.height < 1 || result.width > 8192 || result.height > 8192) {
    error(label, "media dimensions must be from 1 to 8192 pixels")
  }
  return result
}

async function readShowcaseMedia(packageDirectory, descriptor, role, label) {
  let current = packageDirectory
  for (const segment of descriptor.path.split("/")) {
    current = path.join(current, segment)
    let stat
    try { stat = await fs.lstat(current) } catch (cause) {
      if (cause?.code === "ENOENT") error(label, `missing declared file ${descriptor.path}`)
      throw cause
    }
    if (stat.isSymbolicLink()) error(label, `symlink is forbidden: ${descriptor.path}`)
  }
  const stat = await fs.stat(current)
  if (!stat.isFile()) error(label, `must be a regular file: ${descriptor.path}`)
  const maximum = role === "poster" ? maxPosterBytes : maxAnimationBytes
  if (stat.size < 1 || stat.size > maximum) error(label, `${role} exceeds ${maximum} bytes`)
  const realRoot = await fs.realpath(packageDirectory)
  const realFile = await fs.realpath(current)
  const relative = path.relative(realRoot, realFile)
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) error(label, "media resolves outside its package")
  const data = await fs.readFile(realFile)
  if (data.length < 1 || data.length > maximum) error(label, `${role} exceeds ${maximum} bytes`)
  const actual = inspectShowcaseMedia(data, descriptor.mime, label)
  if (actual.width !== descriptor.width || actual.height !== descriptor.height) {
    error(label, `declared ${descriptor.width}x${descriptor.height} does not match ${actual.width}x${actual.height}`)
  }
  return { ...descriptor, data }
}

export async function loadShowcaseAssets(metadata, packageDirectory, label = `${metadata.kind}/${metadata.id} showcase`) {
  if (!metadata.showcase) return undefined
  const poster = await readShowcaseMedia(packageDirectory, metadata.showcase.poster, "poster", `${label} poster`)
  const animation = metadata.showcase.animation
    ? await readShowcaseMedia(packageDirectory, metadata.showcase.animation, "animation", `${label} animation`)
    : undefined
  return { poster, ...(animation ? { animation } : {}) }
}

async function validateCompanionSourceDirectory(companion, label, workspaceRoot = root) {
  const sourceDirectory = path.join(workspaceRoot, ...companion.source.split("/"))
  let stat
  try { stat = await fs.lstat(sourceDirectory) } catch (cause) {
    if (cause?.code === "ENOENT") error(label, `missing reviewed source directory ${companion.source}`)
    throw cause
  }
  if (stat.isSymbolicLink()) error(label, `source directory must not be a symlink: ${companion.source}`)
  if (!stat.isDirectory()) error(label, `source must be a directory: ${companion.source}`)
  const toolsRoot = await fs.realpath(path.join(workspaceRoot, "packages", "tools"))
  const realSource = await fs.realpath(sourceDirectory)
  const relative = path.relative(toolsRoot, realSource)
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative) || relative.includes(path.sep)) {
    error(label, "source must resolve to one workspace directly below packages/tools/")
  }
  const packageFile = path.join(sourceDirectory, "package.json")
  const packageStat = await fs.lstat(packageFile).catch((cause) => {
    if (cause?.code === "ENOENT") error(label, "reviewed source must contain package.json")
    throw cause
  })
  if (packageStat.isSymbolicLink() || !packageStat.isFile()) error(label, "source package.json must be a regular file, not a symlink")
  const sourcePackage = await readJson(packageFile, `${label} package.json`)
  if (sourcePackage.version !== companion.version) error(label, "companion version must equal source package version")
  if (!isObject(sourcePackage.bin) || typeof sourcePackage.bin[companion.command] !== "string") {
    error(label, "source package bin must declare the companion command")
  }
  for (const target of companion.targets) {
    const script = `build:release:${target.platform}-${target.arch}`
    if (!isObject(sourcePackage.scripts) || typeof sourcePackage.scripts[script] !== "string" ||
        sourcePackage.scripts[script].trim().length === 0) {
      error(label, `source package must declare the ${script} script`)
    }
  }
  return sourcePackage
}

export async function discoverPackages(options = {}) {
  const workspaceRoot = options.workspaceRoot ?? root
  const selection = options.kind === undefined && options.id === undefined
    ? undefined
    : { kind: options.kind, id: options.id }
  if (selection &&
      ((selection.kind !== "plugin" && selection.kind !== "skill") || typeof selection.id !== "string")) {
    error("package selection", "kind and id must select one Plugin or Skill")
  }
  const candidates = [...await listCollection("plugin", workspaceRoot), ...await listCollection("skill", workspaceRoot)]
    .sort((left, right) => `${left.kind}/${left.id}`.localeCompare(`${right.kind}/${right.id}`, "en"))
  const candidatesByIdentity = new Map(candidates.map((candidate) => [`${candidate.kind}/${candidate.id}`, candidate]))
  if (selection && !candidatesByIdentity.has(`${selection.kind}/${selection.id}`)) return []

  const loaded = new Map()
  async function loadCandidate(candidate) {
    const identity = `${candidate.kind}/${candidate.id}`
    const existing = loaded.get(identity)
    if (existing) return existing
    parseId(candidate.id, `${candidate.kind} directory`)
    const metadata = parseSourceMetadata(await readJson(path.join(candidate.directory, "convax-package.json")), `${candidate.kind}/${candidate.id}`)
    if (metadata.kind !== candidate.kind || metadata.id !== candidate.id) error(`${candidate.kind}/${candidate.id}`, "directory and metadata identity differ")
    const packageJson = await validatePackageWorkspace(candidate, metadata)
    const packageRoot = path.join(candidate.directory, "package")
    const files = await collectFiles(packageRoot, `${candidate.kind}/${candidate.id}`)
    assertPackageInventory(files, candidate.kind, `${candidate.kind}/${candidate.id}`)
    const showcase = await loadShowcaseAssets(metadata, candidate.directory)
    let manifest
    if (candidate.kind === "plugin") {
      assertPluginStatic(files, `${candidate.kind}/${candidate.id}`)
      manifest = parsePluginManifest(await readJson(path.join(packageRoot, "manifest.json")), `${candidate.kind}/${candidate.id} manifest`)
      if (metadata.compatibility.pluginSchema !== manifest.schema) {
        error(`${candidate.kind}/${candidate.id}`, "metadata compatibility must match manifest schema")
      }
      for (const key of ["id", "name", "description", "version"]) {
        if (metadata[key] !== manifest[key]) error(`${candidate.kind}/${candidate.id}`, `metadata ${key} must equal manifest`)
      }
      const names = new Set(files.map((file) => file.relativePath))
      if (manifest.entry && !names.has(manifest.entry)) error(`${candidate.kind}/${candidate.id}`, `missing entry ${manifest.entry}`)
      validatePetPackageLibrary(manifest, files, `${candidate.kind}/${candidate.id}`)
      if (manifest.runtime && names.has(manifest.runtime.command)) {
        error(`${candidate.kind}/${candidate.id}`, "external runtime executable must not be included in the Plugin ZIP")
      }
      const companions = metadata.companions ?? []
      if (manifest.runtime) {
        if (companions.length !== 1 || companions[0].command !== manifest.runtime.command) {
          error(`${candidate.kind}/${candidate.id}`, "external runtime must have exactly one matching companion command")
        }
      } else if (companions.length > 0) {
        error(`${candidate.kind}/${candidate.id}`, "companions require a declared external runtime")
      }
      for (const companion of companions) {
        const sourcePackage = await validateCompanionSourceDirectory(
          companion,
          `${candidate.kind}/${candidate.id} companion ${companion.command}`,
          workspaceRoot,
        )
        if (packageJson.dependencies?.[sourcePackage.name] !== "workspace:*") {
          error(`${candidate.kind}/${candidate.id}`, `package.json must depend on Tool workspace ${sourcePackage.name}`)
        }
      }
      if (manifest.skill) {
        const skillFile = files.find((file) => file.relativePath === manifest.skill)
        if (!skillFile) error(`${candidate.kind}/${candidate.id}`, `missing companion Skill ${manifest.skill}`)
        parseSkill(skillFile.data.toString("utf8"), undefined, `${candidate.kind}/${candidate.id} companion Skill`)
      }
    } else {
      const skill = files.find((file) => file.relativePath === "SKILL.md")
      if (!skill) error(`${candidate.kind}/${candidate.id}`, "ZIP root must contain SKILL.md")
      parseSkill(skill.data.toString("utf8"), metadata.id, `${candidate.kind}/${candidate.id} SKILL.md`)
      for (const file of files) {
        if (nativeExtensions.has(path.posix.extname(file.relativePath).toLowerCase())) error(`${candidate.kind}/${candidate.id}`, `native executable is forbidden: ${file.relativePath}`)
      }
    }
    const pkg = { ...candidate, files, manifest, metadata, packageJson, packageRoot, showcase }
    loaded.set(identity, pkg)
    return pkg
  }

  if (!selection) {
    for (const candidate of candidates) await loadCandidate(candidate)
  } else {
    const pending = [`${selection.kind}/${selection.id}`]
    const enqueued = new Set(pending)
    while (pending.length > 0) {
      const identity = pending.shift()
      const candidate = candidatesByIdentity.get(identity)
      if (!candidate) error(identity, "missing required package workspace")
      const pkg = await loadCandidate(candidate)
      const dependencies = []
      if (pkg.metadata.kind === "plugin") {
        for (const contribution of pkg.manifest.contributes.skills ?? []) {
          dependencies.push(`skill/${contribution.name}`)
        }
        const legacySkill = /^skills\/([a-z0-9]+(?:-[a-z0-9]+)*)\/SKILL\.md$/.exec(pkg.manifest.skill ?? "")
        if (legacySkill) dependencies.push(`skill/${legacySkill[1]}`)
      } else if (pkg.metadata.ownerPluginId) {
        dependencies.push(`plugin/${pkg.metadata.ownerPluginId}`)
      }
      for (const dependency of dependencies) {
        if (enqueued.has(dependency)) continue
        enqueued.add(dependency)
        pending.push(dependency)
      }
    }
  }

  const packages = [...loaded.values()].sort((left, right) =>
    `${left.kind}/${left.id}`.localeCompare(`${right.kind}/${right.id}`, "en"))
  composeOwnedSkillPackages(packages)
  return packages
}

export function composeOwnedSkillPackages(packages) {
  const standaloneSkills = new Map(packages
    .filter((pkg) => pkg.metadata.kind === "skill")
    .map((pkg) => [pkg.metadata.id, pkg]))
  for (const plugin of packages.filter((pkg) => pkg.metadata.kind === "plugin")) {
    const ownedSkills = plugin.manifest.contributes.skills ?? []
    const paths = new Set(plugin.files.map((file) => file.relativePath.normalize("NFC").toLowerCase()))
    for (const contribution of ownedSkills) {
      const skill = standaloneSkills.get(contribution.name)
      if (!skill) error(`${plugin.kind}/${plugin.id}`, `missing owned Skill workspace ${contribution.name}`)
      if (skill.metadata.ownerPluginId !== plugin.id) {
        error(`${plugin.kind}/${plugin.id}`, `owned Skill ${contribution.name} must declare ownerPluginId ${plugin.id}`)
      }
      if (plugin.packageJson.dependencies?.[skill.packageJson.name] !== "workspace:*") {
        error(`${plugin.kind}/${plugin.id}`, `package.json must depend on owned Skill workspace ${skill.packageJson.name}`)
      }
      for (const file of skill.files) {
        const relativePath = `${contribution.path}/${file.relativePath}`
        const folded = relativePath.normalize("NFC").toLowerCase()
        if (paths.has(folded)) error(`${plugin.kind}/${plugin.id}`, `owned Skill path collides with ${relativePath}`)
        paths.add(folded)
        plugin.files.push({ ...file, relativePath })
      }
    }
    plugin.files.sort((left, right) => Buffer.compare(Buffer.from(left.relativePath), Buffer.from(right.relativePath)))
    assertPackageInventory(plugin.files, "plugin", `${plugin.kind}/${plugin.id}`)
  }
  for (const skill of packages.filter((pkg) => pkg.metadata.kind === "skill" && pkg.metadata.ownerPluginId)) {
    const owner = packages.find((pkg) => pkg.metadata.kind === "plugin" && pkg.metadata.id === skill.metadata.ownerPluginId)
    const contribution = owner?.manifest.contributes.skills?.find((item) => item.name === skill.metadata.id)
    if (!owner || !contribution) {
      error(`${skill.kind}/${skill.id}`, `ownerPluginId ${skill.metadata.ownerPluginId} does not contribute this Skill`)
    }
  }
  return packages
}

export function tagFor(metadata) {
  return `${metadata.kind}-${metadata.id}-v${metadata.version}`
}

export function assetNameFor(metadata) {
  return `convax-${metadata.kind}-${metadata.id}-${metadata.version}.zip`
}

export function companionAssetNameFor(metadata, companion, target) {
  if (metadata.kind !== "plugin") error("companion asset", "only Plugins may publish companions")
  const suffix = target.platform === "win32" ? ".exe" : ""
  const name = `convax-companion-${companion.command}-${companion.version}-${target.platform}-${target.arch}${suffix}`
  validatePortableSegment(name, "companion asset")
  return name
}

export function showcaseAssetNameFor(metadata, role, mime) {
  const extension = showcaseMimes[role]?.get(mime)
  if (!extension) error("showcase asset", `unsupported ${role} MIME type ${mime}`)
  return `convax-showcase-${metadata.kind}-${metadata.id}-${metadata.version}-${role}${extension}`
}

let crcTable
function crc32(data) {
  if (!crcTable) {
    crcTable = Array.from({ length: 256 }, (_, value) => {
      let result = value
      for (let bit = 0; bit < 8; bit += 1) result = result & 1 ? 0xedb88320 ^ (result >>> 1) : result >>> 1
      return result >>> 0
    })
  }
  let crc = 0xffffffff
  for (const byte of data) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

export function createDeterministicZip(inputFiles) {
  const files = [...inputFiles].sort((left, right) => Buffer.compare(Buffer.from(left.relativePath), Buffer.from(right.relativePath)))
  const localParts = []
  const centralParts = []
  let offset = 0
  for (const file of files) {
    const name = Buffer.from(parseRelativePath(file.relativePath))
    const data = Buffer.from(file.data)
    const crc = crc32(data)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0x0800, 6)
    local.writeUInt16LE(0, 8)
    local.writeUInt16LE(0, 10)
    local.writeUInt16LE(33, 12)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(data.length, 18)
    local.writeUInt32LE(data.length, 22)
    local.writeUInt16LE(name.length, 26)
    local.writeUInt16LE(0, 28)
    localParts.push(local, name, data)

    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(0x0314, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(0x0800, 8)
    central.writeUInt16LE(0, 10)
    central.writeUInt16LE(0, 12)
    central.writeUInt16LE(33, 14)
    central.writeUInt32LE(crc, 16)
    central.writeUInt32LE(data.length, 20)
    central.writeUInt32LE(data.length, 24)
    central.writeUInt16LE(name.length, 28)
    central.writeUInt16LE(0, 30)
    central.writeUInt16LE(0, 32)
    central.writeUInt16LE(0, 34)
    central.writeUInt16LE(0, 36)
    central.writeUInt32LE((0o100644 << 16) >>> 0, 38)
    central.writeUInt32LE(offset, 42)
    centralParts.push(central, name)
    offset += local.length + name.length + data.length
  }
  const centralDirectory = Buffer.concat(centralParts)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(files.length, 8)
  end.writeUInt16LE(files.length, 10)
  end.writeUInt32LE(centralDirectory.length, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...localParts, centralDirectory, end])
}

export function readStoredZip(zip) {
  const entries = []
  let offset = 0
  while (zip.readUInt32LE(offset) === 0x04034b50) {
    const method = zip.readUInt16LE(offset + 8)
    if (method !== 0) error("ZIP", "test reader accepts only stored entries")
    const size = zip.readUInt32LE(offset + 18)
    const nameLength = zip.readUInt16LE(offset + 26)
    const extraLength = zip.readUInt16LE(offset + 28)
    const nameStart = offset + 30
    const dataStart = nameStart + nameLength + extraLength
    const relativePath = zip.subarray(nameStart, nameStart + nameLength).toString("utf8")
    entries.push({ relativePath, data: zip.subarray(dataStart, dataStart + size) })
    offset = dataStart + size
  }
  return entries
}

export function sha256(data) {
  return createHash("sha256").update(data).digest("hex")
}

async function readCompanionArtifact(sourceDirectory, target, label) {
  const sourceStat = await fs.lstat(sourceDirectory)
  if (sourceStat.isSymbolicLink()) error(label, "reviewed source directory must not be a symlink")
  if (!sourceStat.isDirectory()) error(label, "reviewed source must be a directory")
  let current = sourceDirectory
  for (const segment of target.path.split("/")) {
    current = path.join(current, segment)
    let stat
    try { stat = await fs.lstat(current) } catch (cause) {
      if (cause?.code === "ENOENT") error(label, `missing built artifact ${target.path}`)
      throw cause
    }
    if (stat.isSymbolicLink()) error(label, `symlink is forbidden: ${target.path}`)
  }
  const before = await fs.stat(current)
  if (!before.isFile()) error(label, `artifact must be a regular file: ${target.path}`)
  if (before.size < 1 || before.size > maxCompanionBytes) {
    error(label, `artifact size must be from 1 to ${maxCompanionBytes} bytes`)
  }
  if (target.platform !== "win32" && (before.mode & 0o111) === 0) {
    error(label, "POSIX companion artifact must have an executable mode")
  }
  if (target.platform === "win32" && !target.path.toLowerCase().endsWith(".exe")) {
    error(label, "win32 companion artifact path must end in .exe")
  }
  const realSource = await fs.realpath(sourceDirectory)
  const realFile = await fs.realpath(current)
  const relative = path.relative(realSource, realFile)
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    error(label, "artifact resolves outside its reviewed source directory")
  }
  const data = await fs.readFile(realFile)
  const after = await fs.stat(realFile)
  if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || data.length !== after.size) {
    error(label, "artifact changed while it was being read")
  }
  return data
}

export async function loadCompanionArtifacts(pkg, label = `${pkg.metadata.kind}/${pkg.metadata.id} companions`) {
  const declarations = pkg.metadata.companions
  if (!declarations) return []
  const companions = []
  const assetNames = new Set()
  for (const companion of declarations) {
    const sourceDirectory = path.join(root, ...companion.source.split("/"))
    const targets = []
    for (const target of companion.targets) {
      const targetLabel = `${label} ${companion.command} ${target.platform}/${target.arch}`
      const data = await readCompanionArtifact(sourceDirectory, target, targetLabel)
      const assetName = companionAssetNameFor(pkg.metadata, companion, target)
      if (assetNames.has(assetName)) error(label, `duplicate artifact asset name ${assetName}`)
      assetNames.add(assetName)
      targets.push({
        platform: target.platform,
        arch: target.arch,
        assetName,
        data,
        artifact: {
          url: `https://github.com/${repository}/releases/download/${tagFor(pkg.metadata)}/${assetName}`,
          size: data.length,
          sha256: sha256(data),
        },
      })
    }
    companions.push({ command: companion.command, version: companion.version, targets })
  }
  return companions
}

export function createRegistryEntry(pkg, zip, companionArtifacts = []) {
  const metadata = pkg.metadata
  const tag = tagFor(metadata)
  const assetName = assetNameFor(metadata)
  return {
    kind: metadata.kind,
    id: metadata.id,
    name: metadata.name,
    description: metadata.description,
    version: metadata.version,
    compatibility: metadata.compatibility,
    artifact: {
      url: `https://github.com/${repository}/releases/download/${tag}/${assetName}`,
      size: zip.length,
      sha256: sha256(zip),
    },
    yanked: metadata.yanked,
    ...(metadata.kind === "skill" && metadata.ownerPluginId ? { ownerPluginId: metadata.ownerPluginId } : {}),
    ...(metadata.kind === "plugin" ? {
      manifest: pkg.manifest,
      ...(companionArtifacts.length > 0 ? {
        companions: companionArtifacts.map((companion) => ({
          command: companion.command,
          version: companion.version,
          targets: companion.targets.map((target) => ({
            platform: target.platform,
            arch: target.arch,
            artifact: target.artifact,
          })),
        })),
      } : {}),
    } : {}),
  }
}

function createShowcaseMediaArtifact(metadata, media, role) {
  const assetName = showcaseAssetNameFor(metadata, role, media.mime)
  return {
    url: `https://github.com/${repository}/releases/download/${tagFor(metadata)}/${assetName}`,
    mime: media.mime,
    size: media.data.length,
    sha256: sha256(media.data),
    width: media.width,
    height: media.height,
    alt: media.alt,
  }
}

export function createShowcaseEntry(pkg) {
  if (!pkg.showcase) return undefined
  const metadata = pkg.metadata
  return {
    schema: showcaseEntrySchema,
    kind: metadata.kind,
    id: metadata.id,
    version: metadata.version,
    poster: createShowcaseMediaArtifact(metadata, pkg.showcase.poster, "poster"),
    ...(pkg.showcase.animation
      ? { animation: createShowcaseMediaArtifact(metadata, pkg.showcase.animation, "animation") }
      : {}),
  }
}

function parseShowcaseIdentity(value, label) {
  if (value.kind !== "plugin" && value.kind !== "skill") error(label, "kind must be plugin or skill")
  const id = parseId(value.id, `${label} id`)
  if (value.kind === "skill" && id.length > 64) error(label, "Skill id must be at most 64 characters")
  return { kind: value.kind, id, version: parseSemver(value.version, `${label} version`) }
}

function parseShowcaseMediaArtifact(value, metadata, role, label) {
  exactKeys(value, ["alt", "height", "mime", "sha256", "size", "url", "width"],
    ["alt", "height", "mime", "sha256", "size", "url", "width"], label)
  const mime = cleanString(value.mime, `${label} mime`, 80)
  if (!showcaseMimes[role].has(mime)) error(label, `unsupported ${role} MIME type ${mime}`)
  const assetName = showcaseAssetNameFor(metadata, role, mime)
  const expectedUrl = `https://github.com/${repository}/releases/download/${tagFor(metadata)}/${assetName}`
  if (value.url !== expectedUrl) error(label, `url must equal ${expectedUrl}`)
  const maximum = role === "poster" ? maxPosterBytes : maxAnimationBytes
  if (!Number.isSafeInteger(value.size) || value.size < 1 || value.size > maximum) error(label, "invalid size")
  if (typeof value.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(value.sha256)) error(label, "invalid sha256")
  const width = dimension(value.width, `${label} width`)
  const height = dimension(value.height, `${label} height`)
  if (width === undefined || height === undefined) error(label, "width and height are required")
  return {
    url: value.url,
    mime,
    size: value.size,
    sha256: value.sha256,
    width,
    height,
    alt: cleanString(value.alt, `${label} alt`, 500),
  }
}

function parseShowcasePackage(value, label) {
  const required = ["kind", "id", "version", "poster"]
  exactKeys(value, [...required, "animation"], required, label)
  const metadata = parseShowcaseIdentity(value, label)
  return {
    ...metadata,
    poster: parseShowcaseMediaArtifact(value.poster, metadata, "poster", `${label} poster`),
    ...(value.animation === undefined
      ? {}
      : { animation: parseShowcaseMediaArtifact(value.animation, metadata, "animation", `${label} animation`) }),
  }
}

export function parseShowcaseEntry(value, label = "Showcase entry") {
  exactKeys(value, ["animation", "id", "kind", "poster", "schema", "version"],
    ["id", "kind", "poster", "schema", "version"], label)
  if (value.schema !== showcaseEntrySchema) error(label, "unsupported schema")
  return { schema: showcaseEntrySchema, ...parseShowcasePackage({
    kind: value.kind,
    id: value.id,
    version: value.version,
    poster: value.poster,
    ...(value.animation === undefined ? {} : { animation: value.animation }),
  }, label) }
}

export function parseShowcase(value, label = "Showcase") {
  exactKeys(value, ["packages", "revision", "schema", "sequence"], ["packages", "revision", "schema", "sequence"], label)
  if (value.schema !== showcaseSchema) error(label, "unsupported schema")
  if (!Number.isSafeInteger(value.sequence) || value.sequence < 1) error(label, "sequence must be a positive integer")
  const revision = cleanString(value.revision, `${label} revision`, 40)
  if (!/^[a-f0-9]{40}$/.test(revision)) error(label, "revision must be a lowercase 40-character Git SHA")
  if (!Array.isArray(value.packages) || value.packages.length > 10_000) error(label, "packages must be an array with at most 10000 items")
  const packages = value.packages.map((entry, index) => parseShowcasePackage(entry, `${label} package ${index}`))
  const identities = packages.map((entry) => `${entry.kind}/${entry.id}`)
  if (new Set(identities).size !== identities.length) error(label, "contains more than one version for a package")
  const urls = packages.flatMap((entry) => [entry.poster.url, ...(entry.animation ? [entry.animation.url] : [])])
  if (new Set(urls).size !== urls.length) error(label, "reuses a media URL")
  return { schema: showcaseSchema, sequence: value.sequence, revision, packages }
}

function parseArtifact(value, metadata, label) {
  exactKeys(value, ["url", "size", "sha256"], ["url", "size", "sha256"], label)
  const expected = `https://github.com/${repository}/releases/download/${tagFor(metadata)}/${assetNameFor(metadata)}`
  if (value.url !== expected) error(label, `url must equal ${expected}`)
  if (!Number.isSafeInteger(value.size) || value.size < 1 || value.size > maxPackageBytes) error(label, "invalid size")
  if (typeof value.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(value.sha256)) error(label, "invalid sha256")
  return { url: value.url, size: value.size, sha256: value.sha256 }
}

function parseCompanionArtifact(value, metadata, companion, target, label) {
  exactKeys(value, ["sha256", "size", "url"], ["sha256", "size", "url"], label)
  const assetName = companionAssetNameFor(metadata, companion, target)
  const expected = `https://github.com/${repository}/releases/download/${tagFor(metadata)}/${assetName}`
  if (value.url !== expected) error(label, `url must equal ${expected}`)
  if (!Number.isSafeInteger(value.size) || value.size < 1 || value.size > maxCompanionBytes) {
    error(label, "invalid size")
  }
  if (typeof value.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(value.sha256)) {
    error(label, "invalid sha256")
  }
  return { url: value.url, size: value.size, sha256: value.sha256 }
}

function parseRegistryCompanions(value, metadata, manifest, label) {
  if (value === undefined) return undefined
  if ((manifest.schema !== "convax.plugin/2" && manifest.schema !== "convax.plugin/3" &&
       manifest.schema !== "convax.plugin/4" && manifest.schema !== "convax.plugin/5") || !manifest.runtime) {
    error(label, "companions require a convax.plugin/2 or later external runtime")
  }
  if (!Array.isArray(value) || value.length < 1 || value.length > 16) {
    error(label, "must be a non-empty array with at most 16 items")
  }
  const companions = value.map((item, index) => {
    const itemLabel = `${label} item ${index}`
    exactKeys(item, ["command", "targets", "version"], ["command", "targets", "version"], itemLabel)
    const companion = {
      command: parseCompanionCommand(item.command, `${itemLabel} command`),
      version: parseSemver(item.version, `${itemLabel} version`),
    }
    if (!Array.isArray(item.targets) || item.targets.length < 1 || item.targets.length > 16) {
      error(itemLabel, "targets must be a non-empty array with at most 16 items")
    }
    const targets = item.targets.map((target, targetIndex) => {
      const targetLabel = `${itemLabel} target ${targetIndex}`
      exactKeys(target, ["arch", "artifact", "platform"], ["arch", "artifact", "platform"], targetLabel)
      const identity = parseCompanionTargetIdentity(target, targetLabel)
      return {
        ...identity,
        artifact: parseCompanionArtifact(target.artifact, metadata, companion, identity, `${targetLabel} artifact`),
      }
    })
    const identities = targets.map((target) => `${target.platform}/${target.arch}`)
    if (new Set(identities).size !== identities.length) error(itemLabel, "contains a duplicate platform/architecture target")
    return { ...companion, targets }
  })
  if (new Set(companions.map((item) => item.command)).size !== companions.length) {
    error(label, "contains duplicate commands")
  }
  if (companions.length !== 1 || companions[0].command !== manifest.runtime.command) {
    error(label, "must contain exactly the declared external runtime command")
  }
  return companions
}

export function parseRegistryEntry(value, label = "Registry entry") {
  if (!isObject(value) || (value.kind !== "plugin" && value.kind !== "skill")) error(label, "invalid kind")
  const required = ["kind", "id", "name", "description", "version", "compatibility", "artifact", "yanked",
    ...(value.kind === "plugin" ? ["manifest"] : [])]
  const allowed = [...required, ...(value.kind === "plugin" ? ["companions"] : ["ownerPluginId"])]
  exactKeys(value, allowed, required, label)
  const metadata = parseSourceMetadata({ schema: "convax.package/1", kind: value.kind, id: value.id,
    name: value.name, description: value.description, version: value.version, license: "registry",
    compatibility: value.compatibility, yanked: value.yanked,
    ...(value.kind === "skill" && value.ownerPluginId !== undefined ? { ownerPluginId: value.ownerPluginId } : {}) }, label)
  const result = {
    kind: metadata.kind,
    id: metadata.id,
    name: metadata.name,
    description: metadata.description,
    version: metadata.version,
    compatibility: metadata.compatibility,
    artifact: parseArtifact(value.artifact, metadata, `${label} artifact`),
    yanked: metadata.yanked,
    ...(metadata.ownerPluginId === undefined ? {} : { ownerPluginId: metadata.ownerPluginId }),
  }
  if (metadata.kind === "plugin") {
    const manifest = parsePluginManifest(value.manifest, `${label} manifest`)
    if (metadata.compatibility.pluginSchema !== manifest.schema) {
      error(label, "compatibility must match manifest schema")
    }
    for (const key of ["id", "name", "description", "version"]) {
      if (metadata[key] !== manifest[key]) error(label, `${key} must equal manifest`)
    }
    const companions = parseRegistryCompanions(value.companions, metadata, manifest, `${label} companions`)
    return { ...result, manifest, ...(companions === undefined ? {} : { companions }) }
  }
  return result
}

export function parseRegistry(value, label = "Registry") {
  exactKeys(value, ["schema", "sequence", "revision", "packages"], ["schema", "sequence", "revision", "packages"], label)
  if (value.schema !== registrySchema) error(label, "unsupported schema")
  if (!Number.isSafeInteger(value.sequence) || value.sequence < 1) error(label, "sequence must be a positive integer")
  const revision = cleanString(value.revision, `${label} revision`, 40)
  if (!/^[a-f0-9]{40}$/.test(revision)) error(label, "revision must be a lowercase 40-character Git SHA")
  if (!Array.isArray(value.packages) || value.packages.length > 10_000) error(label, "packages must be an array with at most 10000 items")
  const packages = value.packages.map((entry, index) => parseRegistryEntry(entry, `${label} package ${index}`))
  const identities = packages.map((entry) => `${entry.kind}/${entry.id}`)
  if (new Set(identities).size !== identities.length) error(label, "contains more than one version for a package")
  const pluginsById = new Map(packages
    .filter((entry) => entry.kind === "plugin")
    .map((entry) => [entry.id, entry]))
  const skillsById = new Map(packages
    .filter((entry) => entry.kind === "skill")
    .map((entry) => [entry.id, entry]))
  for (const skill of packages.filter((entry) => entry.kind === "skill" && entry.ownerPluginId)) {
    const owner = pluginsById.get(skill.ownerPluginId)
    const contribution = owner?.manifest.schema === "convax.plugin/4" || owner?.manifest.schema === "convax.plugin/5"
      ? owner.manifest.contributes.skills?.find((item) => item.name === skill.id)
      : undefined
    if (!owner || !contribution) {
      error(label, `Skill ${skill.id} ownerPluginId ${skill.ownerPluginId} does not match a Plugin-owned Skill contribution`)
    }
  }
  for (const plugin of packages.filter((entry) =>
    entry.kind === "plugin" &&
    (entry.manifest.schema === "convax.plugin/4" || entry.manifest.schema === "convax.plugin/5"))) {
    for (const contribution of plugin.manifest.contributes.skills ?? []) {
      const skill = skillsById.get(contribution.name)
      if (!skill || skill.ownerPluginId !== plugin.id) {
        error(label, `Plugin ${plugin.id} owned Skill ${contribution.name} does not match a Skill ownerPluginId`)
      }
    }
  }
  const artifactUrls = packages.flatMap((entry) => [
    entry.artifact.url,
    ...(entry.kind === "plugin" && entry.companions
      ? entry.companions.flatMap((companion) => companion.targets.map((target) => target.artifact.url))
      : []),
  ])
  if (new Set(artifactUrls).size !== artifactUrls.length) error(label, "reuses an artifact URL")
  return { schema: registrySchema, sequence: value.sequence, revision, packages }
}

export function parseArgs(argv) {
  const result = {}
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (!argument.startsWith("--")) error("arguments", `unexpected ${argument}`)
    const key = argument.slice(2)
    const value = argv[++index]
    if (!value || value.startsWith("--")) error("arguments", `${argument} requires a value`)
    result[key] = value
  }
  return result
}

export function json(value) {
  return `${JSON.stringify(value, null, 2)}\n`
}
