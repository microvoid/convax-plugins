import { promises as fs } from "node:fs"
import path from "node:path"
import { discoverPackages, exactKeys, readJson, root } from "./lib.mjs"

function validateLocalMarkdownReferences(files, label) {
  const paths = new Set(files.map((file) => file.relativePath))
  for (const file of files.filter((item) => item.relativePath.endsWith(".md"))) {
    const markdown = file.data.toString("utf8")
    const links = markdown.matchAll(/!?\[[^\]]*\]\(\s*<?([^\s)>]+)>?(?:\s+["'][^)]*["'])?\s*\)/g)
    for (const match of links) {
      const target = match[1]
      if (target.startsWith("#") || target.startsWith("/") || /^[a-z][a-z0-9+.-]*:/i.test(target)) continue
      const pathOnly = target.split(/[?#]/, 1)[0]
      if (!pathOnly) continue
      let decoded
      try {
        decoded = decodeURIComponent(pathOnly)
      } catch {
        throw new Error(`${label}: ${file.relativePath} contains an invalid local Markdown reference ${target}`)
      }
      const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(file.relativePath), decoded))
      if (resolved === ".." || resolved.startsWith("../") || !paths.has(resolved)) {
        throw new Error(`${label}: ${file.relativePath} references missing package file ${target}`)
      }
    }
  }
}

export async function validateRepository() {
  const config = await readJson(path.join(root, "registry", "config.json"), "registry/config.json")
  exactKeys(config, ["sequence", "yanked"], ["sequence", "yanked"], "registry/config.json")
  if (!Number.isSafeInteger(config.sequence) || config.sequence < 1) {
    throw new Error("registry/config.json: sequence must be a positive integer")
  }
  if (!Array.isArray(config.yanked) ||
      config.yanked.some((identity) => typeof identity !== "string" ||
        !/^(plugin|skill)\/[a-z0-9]+(?:-[a-z0-9]+)*@[^@]+$/.test(identity)) ||
      new Set(config.yanked).size !== config.yanked.length) {
    throw new Error("registry/config.json: yanked must contain unique kind/id@version identities")
  }
  const schemaDirectory = path.join(root, "schemas")
  const schemaNames = [
    "convax-package-v1.schema.json",
    "convax-plugin-manifest-v1.schema.json",
    "convax-plugin-manifest-v2.schema.json",
    "convax-registry-v1.schema.json",
    "convax-showcase-entry-v1.schema.json",
    "convax-showcase-v1.schema.json",
  ]
  for (const name of schemaNames) await readJson(path.join(schemaDirectory, name), `schemas/${name}`)
  const packages = await discoverPackages()
  if (packages.length === 0) throw new Error("At least one source package is required")
  for (const plugin of packages.filter((pkg) => pkg.metadata.kind === "plugin" && pkg.manifest.skill)) {
    const match = /^skills\/([a-z0-9]+(?:-[a-z0-9]+)*)\/SKILL\.md$/.exec(plugin.manifest.skill)
    if (!match) continue
    const skillId = match[1]
    const standalone = packages.find((pkg) => pkg.metadata.kind === "skill" && pkg.metadata.id === skillId)
    if (!standalone) {
      throw new Error(`plugin/${plugin.metadata.id}: missing standalone companion Skill ${skillId}`)
    }
    const prefix = `skills/${skillId}/`
    const embedded = plugin.files
      .filter((file) => file.relativePath.startsWith(prefix))
      .map((file) => ({ ...file, relativePath: file.relativePath.slice(prefix.length) }))
    const source = standalone.files
    validateLocalMarkdownReferences(source, `skill/${skillId}`)
    validateLocalMarkdownReferences(embedded, `plugin/${plugin.metadata.id} embedded skill/${skillId}`)
    if (embedded.map((file) => file.relativePath).join("\n") !== source.map((file) => file.relativePath).join("\n")) {
      throw new Error(`plugin/${plugin.metadata.id}: embedded companion Skill file set differs from skill/${skillId}`)
    }
    for (let index = 0; index < source.length; index += 1) {
      if (!embedded[index].data.equals(source[index].data)) {
        throw new Error(`plugin/${plugin.metadata.id}: embedded ${source[index].relativePath} differs from skill/${skillId}`)
      }
    }
  }
  for (const template of ["plugin-basic", "skill-basic"]) {
    const metadata = await fs.readFile(path.join(root, "templates", template, "convax-package.json"), "utf8")
    if (!metadata.includes("__")) throw new Error(`templates/${template}: expected replacement tokens`)
  }
  return { packages, sequence: config.sequence }
}

if (import.meta.main) {
  const result = await validateRepository()
  console.log(`Validated ${result.packages.length} packages at Registry sequence ${result.sequence}.`)
}
