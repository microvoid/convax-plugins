import { promises as fs } from "node:fs"
import path from "node:path"
import { execFileSync } from "node:child_process"
import { exactKeys, json, parseArgs, parseRegistry, parseRegistryEntry, readJson, registrySchema, root } from "./lib.mjs"

async function findEntries(directory) {
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
      else if (entry.isFile() && entry.name === "registry-entry.json") files.push(absolute)
    }
  }
  await visit(directory)
  files.sort()
  return files
}

export async function buildIndex({ entriesDirectory, outputFile, revision, sequence, yanked = [] }) {
  const files = await findEntries(entriesDirectory)
  if (files.length === 0) throw new Error(`No registry-entry.json files found below ${entriesDirectory}`)
  const candidates = []
  const yankedSet = new Set(yanked)
  for (const file of files) {
    const entry = parseRegistryEntry(await readJson(file), path.relative(root, file))
    const identity = `${entry.kind}/${entry.id}@${entry.version}`
    candidates.push(yankedSet.has(identity) ? { ...entry, yanked: true } : entry)
  }
  const latest = new Map()
  for (const entry of candidates) {
    const parts = stableVersion(entry.version)
    if (!parts) continue
    const identity = `${entry.kind}/${entry.id}`
    const previous = latest.get(identity)
    const comparison = previous ? compareStableVersions(parts, previous.parts) : 1
    if (!previous || comparison > 0) latest.set(identity, { entry, parts })
    else if (comparison === 0 && entry.version !== previous.entry.version) {
      throw new Error(`${identity}: multiple releases have equal stable SemVer precedence`)
    }
  }
  const packages = [...latest.values()].map((value) => value.entry)
  packages.sort((left, right) => {
    const a = `${left.kind}\u0000${left.id}\u0000${left.version}`
    const b = `${right.kind}\u0000${right.id}\u0000${right.version}`
    return a < b ? -1 : a > b ? 1 : 0
  })
  const registry = parseRegistry({ schema: registrySchema, sequence, revision, packages })
  await fs.mkdir(path.dirname(outputFile), { recursive: true })
  await fs.writeFile(outputFile, json(registry))
  return registry
}

function stableVersion(version) {
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.exec(version)
  return match ? [BigInt(match[1]), BigInt(match[2]), BigInt(match[3])] : undefined
}

function compareStableVersions(left, right) {
  for (let index = 0; index < 3; index += 1) {
    if (left[index] < right[index]) return -1
    if (left[index] > right[index]) return 1
  }
  return 0
}

function currentRevision() {
  const revision = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim()
  if (!/^[a-f0-9]{40}$/.test(revision)) throw new Error("git rev-parse HEAD did not return a lowercase 40-character SHA")
  return revision
}

export async function buildIndexFromArgs(argv) {
  const args = parseArgs(argv.filter((argument) => argument !== "--"))
  const supported = new Set(["entries", "output", "revision", "sequence"])
  const unknown = Object.keys(args).find((key) => !supported.has(key))
  if (unknown) throw new Error(`arguments: unsupported --${unknown}`)
  const config = await readJson(path.join(root, "registry", "config.json"), "registry/config.json")
  exactKeys(config, ["sequence", "yanked"], ["sequence", "yanked"], "registry/config.json")
  const sequence = args.sequence === undefined ? config.sequence : Number(args.sequence)
  const revision = args.revision ?? process.env.GITHUB_SHA ?? currentRevision()
  return buildIndex({
    entriesDirectory: path.resolve(root, args.entries ?? "dist/packages"),
    outputFile: path.resolve(root, args.output ?? "dist/registry/v1/index.json"),
    revision,
    sequence,
    yanked: config.yanked,
  })
}

if (import.meta.main) {
  const registry = await buildIndexFromArgs(process.argv.slice(2))
  console.log(`Built Registry sequence ${registry.sequence} with ${registry.packages.length} packages.`)
}
