import type { SubtitleEngine } from "./engine"
import { McpServer } from "./mcp-server"
import { loadInstalledSubtitleRuntime } from "./runtime/installed"
import { LocalSubtitleEngine } from "./runtime/local-engine"

/** Composition seam for the reviewed native/model runtime added by a later layer. */
export function createServer(engine: SubtitleEngine) {
  return new McpServer(engine)
}

export async function runInstalledServer(companionExecutablePath = process.execPath) {
  const inventory = await loadInstalledSubtitleRuntime(companionExecutablePath)
  const engine = new LocalSubtitleEngine({
    resolveRuntime: async (signal) => {
      if (signal.aborted) throw signal.reason ?? new DOMException("Canceled", "AbortError")
      return inventory
    },
  })
  await createServer(engine).run()
}

if (import.meta.main) {
  void runInstalledServer().catch(() => {
    console.error("[subtitle-studio] verified companion runtime is unavailable")
    process.exit(1)
  })
}
