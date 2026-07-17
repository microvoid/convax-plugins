import { promises as fs } from "node:fs"
import path from "node:path"
import {
  assetNameFor,
  createDeterministicZip,
  createRegistryEntry,
  discoverPackages,
  json,
  parseArgs,
  root,
  tagFor,
} from "./lib.mjs"

export async function packPackages(packages, outputDirectory) {
  await fs.rm(outputDirectory, { recursive: true, force: true })
  const results = []
  for (const pkg of packages) {
    const tag = tagFor(pkg.metadata)
    const directory = path.join(outputDirectory, tag)
    const assetName = assetNameFor(pkg.metadata)
    const zip = createDeterministicZip(pkg.files)
    const entry = createRegistryEntry(pkg, zip)
    await fs.mkdir(directory, { recursive: true })
    const zipPath = path.join(directory, assetName)
    const entryPath = path.join(directory, "registry-entry.json")
    await fs.writeFile(zipPath, zip)
    await fs.writeFile(entryPath, json(entry))
    results.push({ assetName, directory, entry, entryPath, pkg, tag, zip, zipPath })
  }
  return results
}

export async function packFromArgs(argv) {
  const args = parseArgs(argv.filter((argument) => argument !== "--"))
  const supported = new Set(["kind", "id", "tag"])
  const unknown = Object.keys(args).find((key) => !supported.has(key))
  if (unknown) throw new Error(`arguments: unsupported --${unknown}`)
  if ((args.kind && !args.id) || (args.id && !args.kind) || (args.tag && (args.kind || args.id))) {
    throw new Error("arguments: use --tag or the --kind/--id pair")
  }
  let packages = await discoverPackages()
  if (args.tag) packages = packages.filter((pkg) => tagFor(pkg.metadata) === args.tag)
  if (args.kind) packages = packages.filter((pkg) => pkg.metadata.kind === args.kind && pkg.metadata.id === args.id)
  if (packages.length === 0) throw new Error("No package matches the requested identity/tag")
  const results = await packPackages(packages, path.join(root, "dist", "packages"))
  return results
}

if (import.meta.main) {
  const results = await packFromArgs(process.argv.slice(2))
  for (const result of results) console.log(`${result.tag}: ${path.relative(root, result.zipPath)} (${result.zip.length} bytes)`)
}
