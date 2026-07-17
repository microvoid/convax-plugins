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
export const maxPosterBytes = 5 * 1024 * 1024
export const maxAnimationBytes = 20 * 1024 * 1024

const semverPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/
const idPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const windowsReservedName = /^(CON|PRN|AUX|NUL|COM[1-9¹²³]|LPT[1-9¹²³]|CONIN\$|CONOUT\$)$/i
const capabilities = new Set(["canvas.node.read", "canvas.node.write", "project.files.read", "agent.prompt"])
const nativeExtensions = new Set([".app", ".bat", ".cmd", ".com", ".dll", ".dylib", ".exe", ".msi", ".node", ".ps1", ".so", ".wasm"])
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
    if (value.pluginSchema !== "convax.plugin/1" || value.pluginHost !== "convax.plugin-host/1") {
      error(label, "must target convax.plugin/1 and convax.plugin-host/1")
    }
    return { pluginSchema: "convax.plugin/1", pluginHost: "convax.plugin-host/1" }
  }
  exactKeys(value, ["skillSchema"], ["skillSchema"], label)
  if (value.skillSchema !== "opencode.skill/1") error(label, "must target opencode.skill/1")
  return { skillSchema: "opencode.skill/1" }
}

export function parseSourceMetadata(value, label = "convax-package.json") {
  const required = ["schema", "kind", "id", "name", "description", "version", "license", "compatibility", "yanked"]
  exactKeys(value, [...required, "showcase"], required, label)
  if (value.schema !== "convax.package/1") error(label, "unsupported schema")
  if (value.kind !== "plugin" && value.kind !== "skill") error(label, "kind must be plugin or skill")
  if (typeof value.yanked !== "boolean") error(label, "yanked must be a boolean")
  const kind = value.kind
  const id = parseId(value.id, `${label} id`)
  if (kind === "skill" && id.length > 64) error(label, "Skill id must be at most 64 characters")
  return {
    schema: "convax.package/1",
    kind,
    id,
    name: cleanString(value.name, `${label} name`, 120),
    description: cleanString(value.description, `${label} description`, 2000),
    version: parseSemver(value.version, `${label} version`),
    license: cleanString(value.license, `${label} license`, 120),
    compatibility: parseCompatibility(value.compatibility, kind, `${label} compatibility`),
    yanked: value.yanked,
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

export function parsePluginManifest(value, label = "manifest.json") {
  exactKeys(value,
    ["capabilities", "contributes", "description", "entry", "id", "name", "schema", "skill", "version"],
    ["capabilities", "contributes", "description", "entry", "id", "name", "schema", "version"], label)
  if (value.schema !== "convax.plugin/1") error(label, "unsupported schema")
  const entry = parseRelativePath(value.entry, `${label} entry`)
  if (!entry.toLowerCase().endsWith(".html")) error(label, "entry must be an HTML file")
  if (!Array.isArray(value.capabilities) || value.capabilities.length > capabilities.size ||
      value.capabilities.some((item) => typeof item !== "string" || !capabilities.has(item)) ||
      new Set(value.capabilities).size !== value.capabilities.length) error(label, "invalid or duplicate capability")
  exactKeys(value.contributes, ["canvas"], ["canvas"], `${label} contributes`)
  exactKeys(value.contributes.canvas, ["renderer", "toolbar"], ["renderer"], `${label} canvas`)
  const toolbar = parseToolbar(value.contributes.canvas.toolbar, `${label} toolbar`)
  return {
    capabilities: [...value.capabilities],
    contributes: { canvas: {
      renderer: parseRenderer(value.contributes.canvas.renderer, `${label} renderer`),
      ...(toolbar === undefined ? {} : { toolbar }),
    } },
    description: cleanString(value.description, `${label} description`, 2000),
    entry,
    id: parseId(value.id, `${label} id`),
    name: cleanString(value.name, `${label} name`, 120),
    schema: "convax.plugin/1",
    ...(value.skill === undefined ? {} : { skill: parseRelativePath(value.skill, `${label} skill`) }),
    version: parseSemver(value.version, `${label} version`),
  }
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
      files.push({ absolutePath, data, relativePath })
    }
  }
  await visit(directory)
  files.sort((left, right) => Buffer.compare(Buffer.from(left.relativePath), Buffer.from(right.relativePath)))
  return files
}

function assertPluginStatic(files, label) {
  for (const file of files) {
    const extension = path.posix.extname(file.relativePath).toLowerCase()
    if (nativeExtensions.has(extension)) error(label, `executable file type is forbidden: ${file.relativePath}`)
    if ([".html", ".css", ".js", ".mjs"].includes(extension)) {
      const text = file.data.toString("utf8")
      if (/https?:\/\//i.test(text) || /\b(?:fetch|WebSocket|XMLHttpRequest|EventSource)\s*\(/.test(text) ||
          /navigator\.sendBeacon\s*\(/.test(text)) error(label, `remote runtime dependency is forbidden: ${file.relativePath}`)
    }
  }
}

async function listCollection(kind) {
  const collection = path.join(root, "packages", `${kind}s`)
  let entries
  try { entries = await fs.readdir(collection, { withFileTypes: true }) } catch (cause) {
    if (cause?.code === "ENOENT") return []
    throw cause
  }
  return entries.filter((entry) => entry.isDirectory()).map((entry) => ({ kind, id: entry.name, directory: path.join(collection, entry.name) }))
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

export async function discoverPackages() {
  const candidates = [...await listCollection("plugin"), ...await listCollection("skill")]
    .sort((left, right) => `${left.kind}/${left.id}`.localeCompare(`${right.kind}/${right.id}`, "en"))
  const packages = []
  for (const candidate of candidates) {
    parseId(candidate.id, `${candidate.kind} directory`)
    const metadata = parseSourceMetadata(await readJson(path.join(candidate.directory, "convax-package.json")), `${candidate.kind}/${candidate.id}`)
    if (metadata.kind !== candidate.kind || metadata.id !== candidate.id) error(`${candidate.kind}/${candidate.id}`, "directory and metadata identity differ")
    const packageRoot = path.join(candidate.directory, "package")
    const files = await collectFiles(packageRoot, `${candidate.kind}/${candidate.id}`)
    const showcase = await loadShowcaseAssets(metadata, candidate.directory)
    let manifest
    if (candidate.kind === "plugin") {
      assertPluginStatic(files, `${candidate.kind}/${candidate.id}`)
      manifest = parsePluginManifest(await readJson(path.join(packageRoot, "manifest.json")), `${candidate.kind}/${candidate.id} manifest`)
      for (const key of ["id", "name", "description", "version"]) {
        if (metadata[key] !== manifest[key]) error(`${candidate.kind}/${candidate.id}`, `metadata ${key} must equal manifest`)
      }
      const names = new Set(files.map((file) => file.relativePath))
      if (!names.has(manifest.entry)) error(`${candidate.kind}/${candidate.id}`, `missing entry ${manifest.entry}`)
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
    packages.push({ ...candidate, files, manifest, metadata, packageRoot, showcase })
  }
  return packages
}

export function tagFor(metadata) {
  return `${metadata.kind}-${metadata.id}-v${metadata.version}`
}

export function assetNameFor(metadata) {
  return `convax-${metadata.kind}-${metadata.id}-${metadata.version}.zip`
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

export function createRegistryEntry(pkg, zip) {
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
    ...(metadata.kind === "plugin" ? { manifest: pkg.manifest } : {}),
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

export function parseRegistryEntry(value, label = "Registry entry") {
  if (!isObject(value) || (value.kind !== "plugin" && value.kind !== "skill")) error(label, "invalid kind")
  const allowed = ["kind", "id", "name", "description", "version", "compatibility", "artifact", "yanked", ...(value.kind === "plugin" ? ["manifest"] : [])]
  exactKeys(value, allowed, allowed, label)
  const metadata = parseSourceMetadata({ schema: "convax.package/1", kind: value.kind, id: value.id,
    name: value.name, description: value.description, version: value.version, license: "registry",
    compatibility: value.compatibility, yanked: value.yanked }, label)
  const result = {
    kind: metadata.kind,
    id: metadata.id,
    name: metadata.name,
    description: metadata.description,
    version: metadata.version,
    compatibility: metadata.compatibility,
    artifact: parseArtifact(value.artifact, metadata, `${label} artifact`),
    yanked: metadata.yanked,
  }
  if (metadata.kind === "plugin") {
    const manifest = parsePluginManifest(value.manifest, `${label} manifest`)
    for (const key of ["id", "name", "description", "version"]) {
      if (metadata[key] !== manifest[key]) error(label, `${key} must equal manifest`)
    }
    return { ...result, manifest }
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
  const artifactUrls = packages.map((entry) => entry.artifact.url)
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
