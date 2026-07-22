import { constants as fsConstants } from "node:fs"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { spawn } from "node:child_process"

const versionTimeoutMs = 5_000
const maximumVersionBytes = 8 * 1024

export interface CodexLocatorOptions {
  environment?: Readonly<Record<string, string | undefined>>
  platform?: NodeJS.Platform
  probeVersion?: (executable: string) => Promise<boolean>
}

function pathCandidates(environment: Readonly<Record<string, string | undefined>>) {
  const pathValue = environment.PATH
  if (!pathValue) return []
  return pathValue
    .split(path.delimiter)
    .filter((entry) => path.isAbsolute(entry))
    .map((entry) => path.join(entry, "codex"))
}

function applicationCandidates(environment: Readonly<Record<string, string | undefined>>, platform: NodeJS.Platform) {
  if (platform !== "darwin") return []
  const home = environment.HOME || os.homedir()
  return [
    "/Applications/ChatGPT.app/Contents/Resources/codex",
    "/Applications/Codex.app/Contents/Resources/codex",
    ...(path.isAbsolute(home)
      ? [
          path.join(home, "Applications/ChatGPT.app/Contents/Resources/codex"),
          path.join(home, "Applications/Codex.app/Contents/Resources/codex"),
        ]
      : []),
  ]
}

export async function probeCodexVersion(executable: string) {
  return await new Promise<boolean>((resolve) => {
    const child = spawn(executable, ["--version"], {
      env: { LANG: "C", LC_ALL: "C" },
      stdio: ["ignore", "pipe", "ignore"],
    })
    let output = ""
    let settled = false
    const finish = (valid: boolean) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      resolve(valid)
    }
    const timeout = setTimeout(() => {
      child.kill("SIGKILL")
      finish(false)
    }, versionTimeoutMs)
    child.stdout.setEncoding("utf8")
    child.stdout.on("data", (chunk: string) => {
      output += chunk
      if (Buffer.byteLength(output, "utf8") > maximumVersionBytes) {
        child.kill("SIGKILL")
        finish(false)
      }
    })
    child.once("error", () => finish(false))
    child.once("exit", (code) => finish(code === 0 && /^codex-cli\s+\d+\.\d+\.\d+/m.test(output)))
  })
}

export async function resolveCodexExecutable(options: CodexLocatorOptions = {}) {
  const environment = options.environment ?? process.env
  const platform = options.platform ?? process.platform
  const probeVersion = options.probeVersion ?? probeCodexVersion
  const seen = new Set<string>()
  for (const candidate of [...applicationCandidates(environment, platform), ...pathCandidates(environment)]) {
    try {
      const executable = await fs.realpath(candidate)
      if (seen.has(executable)) continue
      seen.add(executable)
      const stat = await fs.stat(executable)
      if (!stat.isFile()) continue
      await fs.access(executable, platform === "win32" ? fsConstants.F_OK : fsConstants.X_OK)
      if (await probeVersion(executable)) return executable
    } catch {
      // Missing, unreadable, and invalid candidates are not valid bindings.
    }
  }
  throw new Error("A compatible local Codex installation was not found")
}
