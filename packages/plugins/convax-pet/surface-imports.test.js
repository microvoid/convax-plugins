import { describe, expect, test } from "bun:test"
import fs from "node:fs/promises"

const packageRoot = new URL("./package/", import.meta.url)
const scanner = new Bun.Transpiler({ loader: "js" })

async function expectRelativeModuleGraph(entry) {
  const pending = [entry]
  const visited = new Set()

  while (pending.length) {
    const moduleUrl = pending.pop()
    if (visited.has(moduleUrl.href)) continue
    visited.add(moduleUrl.href)

    const source = await fs.readFile(moduleUrl, "utf8")
    for (const imported of scanner.scanImports(source)) {
      expect(imported.path).toMatch(/^\.\.?\//)
      const importedUrl = new URL(imported.path, moduleUrl)
      expect(importedUrl.href.startsWith(packageRoot.href)).toBe(true)
      pending.push(importedUrl)
    }
  }
}

describe("Plugin-owned pet surface modules", () => {
  test("uses browser-relative imports throughout the overlay graph", async () => {
    await expectRelativeModuleGraph(new URL("./package/pet/app.js", import.meta.url))
  })

  test("uses browser-relative imports throughout the settings graph", async () => {
    await expectRelativeModuleGraph(new URL("./package/settings/app.js", import.meta.url))
  })
})
