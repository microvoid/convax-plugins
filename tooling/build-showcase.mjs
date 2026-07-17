import { promises as fs } from "node:fs"
import path from "node:path"
import { json, parseArgs, parseRegistry, parseShowcase, parseShowcaseEntry, readJson, root, showcaseSchema } from "./lib.mjs"

async function findShowcaseEntries(directory) {
  const files = []
  async function visit(current) {
    let entries
    try { entries = await fs.readdir(current, { withFileTypes: true }) } catch (cause) {
      if (cause?.code === "ENOENT") return
      throw cause
    }
    for (const entry of entries) {
      const absolute = path.join(current, entry.name)
      if (entry.isDirectory()) await visit(absolute)
      else if (entry.isFile() && entry.name === "showcase-entry.json") files.push(absolute)
    }
  }
  await visit(directory)
  files.sort()
  return files
}

export async function buildShowcase({ entriesDirectory, outputFile, registry }) {
  const catalog = parseRegistry(registry)
  const current = new Map(catalog.packages.map((pkg) => [`${pkg.kind}/${pkg.id}@${pkg.version}`, pkg]))
  const selected = new Map()
  for (const file of await findShowcaseEntries(entriesDirectory)) {
    const entry = parseShowcaseEntry(await readJson(file), path.relative(root, file))
    const identity = `${entry.kind}/${entry.id}@${entry.version}`
    if (!current.has(identity)) continue
    if (selected.has(identity)) throw new Error(`${identity}: duplicate Showcase release entry`)
    const { schema: _schema, ...item } = entry
    selected.set(identity, item)
  }
  const packages = [...selected.values()].sort((left, right) => {
    const a = `${left.kind}\u0000${left.id}\u0000${left.version}`
    const b = `${right.kind}\u0000${right.id}\u0000${right.version}`
    return a < b ? -1 : a > b ? 1 : 0
  })
  const showcase = parseShowcase({
    schema: showcaseSchema,
    sequence: catalog.sequence,
    revision: catalog.revision,
    packages,
  })
  await fs.mkdir(path.dirname(outputFile), { recursive: true })
  await fs.writeFile(outputFile, json(showcase))
  return showcase
}

export async function buildShowcaseFromArgs(argv) {
  const args = parseArgs(argv.filter((argument) => argument !== "--"))
  const supported = new Set(["entries", "output", "registry"])
  const unknown = Object.keys(args).find((key) => !supported.has(key))
  if (unknown) throw new Error(`arguments: unsupported --${unknown}`)
  return buildShowcase({
    entriesDirectory: path.resolve(root, args.entries ?? "dist/packages"),
    outputFile: path.resolve(root, args.output ?? "dist/showcase/v1/index.json"),
    registry: await readJson(path.resolve(root, args.registry ?? "dist/registry/v1/index.json")),
  })
}

if (import.meta.main) {
  const showcase = await buildShowcaseFromArgs(process.argv.slice(2))
  console.log(`Built Showcase sequence ${showcase.sequence} with ${showcase.packages.length} packages.`)
}
