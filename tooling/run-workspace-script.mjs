import { spawn } from "node:child_process"
import { promises as fs } from "node:fs"
import path from "node:path"

import { isObject, readJson, root } from "./lib.mjs"

const collections = ["plugins", "skills", "tools"]

async function discoverWorkspaces(workspaceRoot = root) {
  const workspaces = []
  for (const collection of collections) {
    const directory = path.join(workspaceRoot, "packages", collection)
    const entries = await fs.readdir(directory, { withFileTypes: true }).catch((cause) => {
      if (cause?.code === "ENOENT") return []
      throw cause
    })
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const workspaceDirectory = path.join(directory, entry.name)
      const packageJson = await readJson(
        path.join(workspaceDirectory, "package.json"),
        `packages/${collection}/${entry.name}/package.json`,
      )
      workspaces.push({
        directory: workspaceDirectory,
        label: `${collection}/${entry.name}`,
        packageJson,
      })
    }
  }
  return workspaces.sort((left, right) => left.label.localeCompare(right.label, "en"))
}

function runScript(workspace, script) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["run", script], {
      cwd: workspace.directory,
      stdio: "inherit",
      windowsHide: true,
    })
    child.once("error", reject)
    child.once("exit", (code, signal) => {
      if (signal) reject(new Error(`${workspace.label}: ${script} terminated by ${signal}`))
      else if (code !== 0) reject(new Error(`${workspace.label}: ${script} exited with status ${code}`))
      else resolve()
    })
  })
}

export async function runWorkspaceScript(script, requestedCollections = collections, workspaceRoot = root) {
  if (!/^[a-z][a-z0-9:-]*$/.test(script)) throw new Error(`Invalid workspace script ${script}`)
  if (
    requestedCollections.length === 0 ||
    new Set(requestedCollections).size !== requestedCollections.length ||
    requestedCollections.some((collection) => !collections.includes(collection))
  ) {
    throw new Error(`Workspace collections must be unique values from: ${collections.join(", ")}`)
  }
  const workspaces = await discoverWorkspaces(workspaceRoot)
  const selected = workspaces.filter((workspace) => {
    const collection = workspace.label.split("/", 1)[0]
    return requestedCollections.includes(collection) &&
      isObject(workspace.packageJson.scripts) && typeof workspace.packageJson.scripts[script] === "string"
  }).sort((left, right) => {
    const leftCollection = left.label.split("/", 1)[0]
    const rightCollection = right.label.split("/", 1)[0]
    return requestedCollections.indexOf(leftCollection) - requestedCollections.indexOf(rightCollection) ||
      left.label.localeCompare(right.label, "en")
  })
  for (const workspace of selected) await runScript(workspace, script)
  return selected.map((workspace) => workspace.label)
}

if (import.meta.main) {
  const [script, ...requestedCollections] = process.argv.slice(2)
  if (!script) throw new Error("Usage: bun tooling/run-workspace-script.mjs <script> [plugins skills tools]")
  const workspaces = await runWorkspaceScript(
    script,
    requestedCollections.length > 0 ? requestedCollections : collections,
  )
  console.log(`Ran ${script} in ${workspaces.length} workspace${workspaces.length === 1 ? "" : "s"}.`)
}
