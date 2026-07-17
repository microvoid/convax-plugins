import { promises as fs } from "node:fs"
import path from "node:path"
import { discoverPackages, exactKeys, readJson, root } from "./lib.mjs"

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
    "convax-registry-v1.schema.json",
    "convax-showcase-entry-v1.schema.json",
    "convax-showcase-v1.schema.json",
  ]
  for (const name of schemaNames) await readJson(path.join(schemaDirectory, name), `schemas/${name}`)
  const packages = await discoverPackages()
  if (packages.length === 0) throw new Error("At least one source package is required")
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
