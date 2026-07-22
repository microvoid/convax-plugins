#!/usr/bin/env bun

import { McpServer } from "./mcp-server.ts"
import { CodexRuntime } from "./runtime.ts"

const shutdownGracePeriodMs = 5_000

export function createServer(environment: Record<string, string | undefined> = process.env) {
  return new McpServer(new CodexRuntime({ environment }))
}

async function run() {
  if (process.argv.length > 2) throw new Error("Usage: convax-codex-mcp")
  const server = createServer()
  let shutdown: Promise<boolean> | undefined
  const stop = () => {
    shutdown ??= server.shutdown(shutdownGracePeriodMs)
    void shutdown.then(
      (drained) => {
        if (!drained) console.error("[codex] shutdown grace period expired")
        process.exit(0)
      },
      () => process.exit(1),
    )
  }
  process.once("SIGINT", stop)
  process.once("SIGTERM", stop)
  try {
    await server.run()
  } finally {
    try {
      await (shutdown ?? server.shutdown(shutdownGracePeriodMs))
    } finally {
      process.removeListener("SIGINT", stop)
      process.removeListener("SIGTERM", stop)
    }
  }
}

if (import.meta.main) await run()
