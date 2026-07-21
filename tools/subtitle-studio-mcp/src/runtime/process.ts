import { spawn } from "node:child_process"

export interface RuntimeCommandResult {
  stderr: string
  stdout: string
}

export type RuntimeCommandRunner = (
  executable: string,
  args: readonly string[],
  signal: AbortSignal,
) => Promise<RuntimeCommandResult>

export interface RuntimeCommandRunnerOptions {
  maximumOutputBytes?: number
  terminationGraceMs?: number
}

export function createRuntimeCommandRunner(options: RuntimeCommandRunnerOptions = {}): RuntimeCommandRunner {
  const maximumOutputBytes = options.maximumOutputBytes ?? 4 * 1024 * 1024
  const terminationGraceMs = options.terminationGraceMs ?? 1_000
  if (!Number.isSafeInteger(maximumOutputBytes) || maximumOutputBytes < 1) {
    throw new Error("Runtime command output limit must be positive")
  }
  if (!Number.isSafeInteger(terminationGraceMs) || terminationGraceMs < 1) {
    throw new Error("Runtime command termination grace period must be positive")
  }
  return (executable, args, signal) => {
    if (signal.aborted) return Promise.reject(signal.reason ?? new DOMException("Canceled", "AbortError"))
    return new Promise((resolve, reject) => {
      const child = spawn(executable, [...args], {
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      })
      const stdout: Buffer[] = []
      const stderr: Buffer[] = []
      let outputBytes = 0
      let settled = false
      let terminationError: unknown
      let terminationTimer: ReturnType<typeof setTimeout> | undefined
      const finish = (callback: () => void) => {
        if (settled) return
        settled = true
        signal.removeEventListener("abort", abort)
        if (terminationTimer) clearTimeout(terminationTimer)
        callback()
      }
      const terminate = (error: unknown, graceful: boolean) => {
        if (settled || terminationError !== undefined) return
        terminationError = error
        child.kill(graceful ? "SIGTERM" : "SIGKILL")
        if (!graceful) return
        terminationTimer = setTimeout(() => {
          terminationTimer = undefined
          if (!settled) child.kill("SIGKILL")
        }, terminationGraceMs)
        terminationTimer.unref()
      }
      const append = (target: Buffer[], chunk: Buffer) => {
        if (settled || terminationError !== undefined) return
        outputBytes += chunk.length
        if (outputBytes > maximumOutputBytes) {
          terminate(new Error("Runtime command produced too much output"), false)
          return
        }
        target.push(chunk)
      }
      const abort = () => terminate(signal.reason ?? new DOMException("Canceled", "AbortError"), true)
      signal.addEventListener("abort", abort, { once: true })
      if (signal.aborted) abort()
      child.stdout.on("data", (chunk: Buffer) => append(stdout, chunk))
      child.stderr.on("data", (chunk: Buffer) => append(stderr, chunk))
      child.once("error", (error) => finish(() => reject(terminationError ?? error)))
      child.once("close", (code, childSignal) =>
        finish(() => {
          if (terminationError !== undefined) {
            reject(terminationError)
            return
          }
          const output = {
            stderr: Buffer.concat(stderr).toString("utf8"),
            stdout: Buffer.concat(stdout).toString("utf8"),
          }
          if (code === 0) resolve(output)
          else reject(new Error(`Runtime command failed${code === null ? "" : ` with code ${code}`}${childSignal ? ` (${childSignal})` : ""}`))
        }),
      )
    })
  }
}

export const runRuntimeCommand = createRuntimeCommandRunner()
