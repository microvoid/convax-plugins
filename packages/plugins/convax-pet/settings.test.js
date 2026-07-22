import { describe, expect, test } from "bun:test"
import fs from "node:fs/promises"

describe("Plugin-owned pet settings", () => {
  test("normalizes stale selection to Violet without changing wake state", async () => {
    const { normalizePreferences, selectPreference } = await import("./package/settings/model.js")

    expect(normalizePreferences({ awake: false, selectedPetId: "missing" })).toEqual({
      awake: false,
      selectedPetId: "violet",
    })
    expect(selectPreference({ awake: true, selectedPetId: "violet" }, "violet")).toEqual({
      selectedPetId: "violet",
    })
  })

  test("keeps wake and tuck as explicit lifecycle requests", async () => {
    const { wakeRequest } = await import("./package/settings/model.js")

    expect(wakeRequest(true)).toEqual({ awake: true })
    expect(wakeRequest(false)).toEqual({ awake: false })
  })

  test("ships a local collection surface without import or deletion controls", async () => {
    const html = await fs.readFile(new URL("./package/settings/index.html", import.meta.url), "utf8")
    const app = await fs.readFile(new URL("./package/settings/app.js", import.meta.url), "utf8")
    const combined = `${html}\n${app}`

    expect(html).toContain('<script type="module" src="app.js"></script>')
    expect(html).toContain('<link rel="stylesheet" href="styles.css">')
    expect(combined).not.toMatch(/\b(?:import custom|upload|delete pet|pet\.json|file input)\b/i)
    expect(combined).not.toMatch(/<input[^>]+type=["']file|https?:\/\//i)
    expect(app).toContain('client.request("preferences.update"')
    expect(app).toContain('client.request("lifecycle.setAwake"')
  })
})
