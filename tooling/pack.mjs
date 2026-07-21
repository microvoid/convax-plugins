import { promises as fs } from "node:fs"
import path from "node:path"
import {
  assetNameFor,
  createDeterministicZip,
  createRegistryEntry,
  createShowcaseEntry,
  discoverPackages,
  json,
  loadCompanionArtifacts,
  parseArgs,
  root,
  sha256,
  showcaseAssetNameFor,
  tagFor,
} from "./lib.mjs"

export async function packPackages(packages, outputDirectory, options = {}) {
  if (options.preserveOtherPackages) {
    await fs.mkdir(outputDirectory, { recursive: true })
    await Promise.all(packages.map((pkg) =>
      fs.rm(path.join(outputDirectory, tagFor(pkg.metadata)), { recursive: true, force: true })))
  } else {
    await fs.rm(outputDirectory, { recursive: true, force: true })
  }
  const results = []
  for (const pkg of packages) {
    const tag = tagFor(pkg.metadata)
    const directory = path.join(outputDirectory, tag)
    const assetName = assetNameFor(pkg.metadata)
    const zip = createDeterministicZip(pkg.files)
    const companions = await loadCompanionArtifacts(pkg)
    const entry = createRegistryEntry(pkg, zip, companions)
    await fs.mkdir(directory, { recursive: true })
    const zipPath = path.join(directory, assetName)
    const entryPath = path.join(directory, "registry-entry.json")
    await fs.writeFile(zipPath, zip)
    await fs.writeFile(entryPath, json(entry))
    const companionAssets = []
    for (const companion of companions) {
      for (const target of companion.targets) {
        const assetPath = path.join(directory, target.assetName)
        await fs.writeFile(assetPath, target.data, { mode: target.platform === "win32" ? 0o644 : 0o755 })
        const written = await fs.readFile(assetPath)
        if (written.length !== target.artifact.size || sha256(written) !== target.artifact.sha256) {
          throw new Error(`${pkg.metadata.kind}/${pkg.metadata.id}: written companion artifact does not match its Registry metadata`)
        }
        companionAssets.push({
          arch: target.arch,
          assetName: target.assetName,
          command: companion.command,
          data: target.data,
          path: assetPath,
          platform: target.platform,
          version: companion.version,
        })
      }
    }
    const showcaseEntry = createShowcaseEntry(pkg)
    const showcaseAssets = []
    let showcaseEntryPath
    if (showcaseEntry) {
      showcaseEntryPath = path.join(directory, "showcase-entry.json")
      await fs.writeFile(showcaseEntryPath, json(showcaseEntry))
      for (const role of ["poster", "animation"]) {
        const media = pkg.showcase[role]
        if (!media) continue
        const name = showcaseAssetNameFor(pkg.metadata, role, media.mime)
        const assetPath = path.join(directory, name)
        await fs.writeFile(assetPath, media.data)
        showcaseAssets.push({ assetName: name, data: media.data, path: assetPath, role })
      }
    }
    results.push({ assetName, companionAssets, directory, entry, entryPath, pkg, showcaseAssets, showcaseEntry, showcaseEntryPath,
      tag, zip, zipPath })
  }
  return results
}

function selectionForTag(tag) {
  if (typeof tag !== "string") return undefined
  const match = /^(plugin|skill)-([a-z0-9]+(?:-[a-z0-9]+)*)-v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.exec(tag)
  return match ? { kind: match[1], id: match[2] } : undefined
}

export async function packFromArgs(argv, options = {}) {
  const args = parseArgs(argv.filter((argument) => argument !== "--"))
  const supported = new Set(["kind", "id", "tag"])
  const unknown = Object.keys(args).find((key) => !supported.has(key))
  if (unknown) throw new Error(`arguments: unsupported --${unknown}`)
  if ((args.kind && !args.id) || (args.id && !args.kind) || (args.tag && (args.kind || args.id))) {
    throw new Error("arguments: use --tag or the --kind/--id pair")
  }
  const workspaceRoot = options.workspaceRoot ?? root
  const outputDirectory = options.outputDirectory ?? path.join(workspaceRoot, "dist", "packages")
  const selection = args.kind ? { kind: args.kind, id: args.id } : selectionForTag(args.tag)
  if (args.tag && !selection) throw new Error("arguments: tag must identify one versioned Plugin or Skill")
  let packages = await discoverPackages({ ...selection, workspaceRoot })
  if (args.tag) packages = packages.filter((pkg) => tagFor(pkg.metadata) === args.tag)
  if (args.kind) packages = packages.filter((pkg) => pkg.metadata.kind === args.kind && pkg.metadata.id === args.id)
  if (packages.length === 0) throw new Error("No package matches the requested identity/tag")
  const results = await packPackages(packages, outputDirectory, {
    preserveOtherPackages: Boolean(args.kind || args.tag),
  })
  return results
}

if (import.meta.main) {
  const results = await packFromArgs(process.argv.slice(2))
  for (const result of results) {
    const showcase = result.showcaseEntry ? `, ${result.showcaseAssets.length} showcase assets` : ""
    const companions = result.companionAssets.length > 0 ? `, ${result.companionAssets.length} companion assets` : ""
    console.log(`${result.tag}: ${path.relative(root, result.zipPath)} (${result.zip.length} bytes${showcase}${companions})`)
  }
}
