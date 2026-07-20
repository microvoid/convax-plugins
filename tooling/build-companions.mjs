import { spawn } from "node:child_process"
import path from "node:path"

import { discoverPackages, loadCompanionArtifacts, parseArgs, root, tagFor } from "./lib.mjs"

function runBuild(source, script) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["run", script], {
      cwd: path.join(root, ...source.split("/")),
      stdio: "inherit",
      windowsHide: true,
    })
    child.once("error", reject)
    child.once("exit", (code, signal) => {
      if (signal) reject(new Error(`${source}: ${script} terminated by ${signal}`))
      else if (code !== 0) reject(new Error(`${source}: ${script} exited with status ${code}`))
      else resolve()
    })
  })
}

export async function buildCompanions(packages) {
  const builds = new Map()
  for (const pkg of packages) {
    for (const companion of pkg.metadata.companions ?? []) {
      for (const target of companion.targets) {
        const identity = `${companion.source}\u0000${target.platform}\u0000${target.arch}`
        const existing = builds.get(identity)
        const build = {
          source: companion.source,
          script: `build:release:${target.platform}-${target.arch}`,
          path: target.path,
        }
        if (existing && (existing.script !== build.script || existing.path !== build.path)) {
          throw new Error(`${companion.source}: duplicate target has inconsistent build metadata`)
        }
        builds.set(identity, build)
      }
    }
  }
  for (const build of builds.values()) await runBuild(build.source, build.script)
  for (const pkg of packages) await loadCompanionArtifacts(pkg)
  return [...builds.values()]
}

export async function buildCompanionsFromArgs(argv) {
  const args = parseArgs(argv.filter((argument) => argument !== "--"))
  const supported = new Set(["id", "kind", "tag"])
  const unknown = Object.keys(args).find((key) => !supported.has(key))
  if (unknown) throw new Error(`arguments: unsupported --${unknown}`)
  if ((args.kind && !args.id) || (args.id && !args.kind) || (args.tag && (args.kind || args.id))) {
    throw new Error("arguments: use --tag or the --kind/--id pair")
  }
  let packages = await discoverPackages()
  if (args.tag) packages = packages.filter((pkg) => tagFor(pkg.metadata) === args.tag)
  if (args.kind) packages = packages.filter((pkg) => pkg.metadata.kind === args.kind && pkg.metadata.id === args.id)
  if (packages.length === 0) throw new Error("No package matches the requested identity/tag")
  return buildCompanions(packages)
}

if (import.meta.main) {
  const builds = await buildCompanionsFromArgs(process.argv.slice(2))
  console.log(`Built and verified ${builds.length} companion target${builds.length === 1 ? "" : "s"}.`)
}
