import { promises as fs } from "node:fs"
import path from "node:path"
import { createShowcaseEntry, discoverPackages, parseArgs, parseShowcaseEntry, readJson, root, tagFor } from "./lib.mjs"

export async function checkReleaseCoverage({ entriesDirectory, packages: suppliedPackages }) {
  const packages = suppliedPackages ?? await discoverPackages()
  const missing = []

  for (const pkg of packages) {
    const tag = tagFor(pkg.metadata)
    const entryFile = path.join(entriesDirectory, tag, "registry-entry.json")
    let entry
    try {
      entry = await readJson(entryFile, path.relative(root, entryFile))
    } catch (cause) {
      if (cause.cause?.code === "ENOENT") {
        missing.push(tag)
        continue
      }
      throw cause
    }
    if (entry.kind !== pkg.metadata.kind || entry.id !== pkg.metadata.id || entry.version !== pkg.metadata.version) {
      throw new Error(`${tag}: Release entry identity does not match source metadata`)
    }

    const showcaseFile = path.join(entriesDirectory, tag, "showcase-entry.json")
    let publishedShowcase
    try {
      publishedShowcase = parseShowcaseEntry(await readJson(showcaseFile, path.relative(root, showcaseFile)), `${tag} Showcase entry`)
    } catch (cause) {
      if (cause.cause?.code !== "ENOENT") throw cause
    }
    const expectedShowcase = createShowcaseEntry(pkg)
    if (expectedShowcase && !publishedShowcase) {
      missing.push(tag)
    } else if (!expectedShowcase && publishedShowcase) {
      throw new Error(`${tag}: Release has Showcase assets not declared by source metadata`)
    } else if (expectedShowcase && JSON.stringify(expectedShowcase) !== JSON.stringify(publishedShowcase)) {
      throw new Error(`${tag}: Release Showcase entry does not match source metadata and media`)
    }
  }

  const uniqueMissing = [...new Set(missing)]
  return { missing: uniqueMissing, ready: uniqueMissing.length === 0 }
}

if (import.meta.main) {
  const args = parseArgs(process.argv.slice(2).filter((argument) => argument !== "--"))
  const unknown = Object.keys(args).find((key) => key !== "entries")
  if (unknown) throw new Error(`arguments: unsupported --${unknown}`)
  const result = await checkReleaseCoverage({
    entriesDirectory: path.resolve(root, args.entries ?? "dist/release-entries"),
  })
  const summary = result.ready
    ? "Every source package has a matching published Release."
    : `Catalog deployment deferred; missing or incomplete Releases: ${result.missing.join(", ")}`
  console.log(summary)
  if (process.env.GITHUB_OUTPUT) await fs.appendFile(process.env.GITHUB_OUTPUT, `ready=${result.ready}\n`)
}
