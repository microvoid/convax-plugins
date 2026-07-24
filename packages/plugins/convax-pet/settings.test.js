import { describe, expect, test } from "bun:test"
import fs from "node:fs/promises"

describe("Plugin-owned pet settings", () => {
  test("normalizes stale selection to Violet without changing wake state", async () => {
    const { normalizePreferences, selectPreference } = await import("./package/settings/model.js")
    const pets = [
      {
        id: "violet",
        source: "builtin",
      },
      {
        id: "custom-nova",
        source: "custom",
      },
    ]

    expect(normalizePreferences({ awake: false, selectedPetId: "missing" })).toEqual({
      awake: false,
      selectedPetId: "violet",
    })
    expect(selectPreference({ awake: true, selectedPetId: "violet" }, "violet")).toEqual({
      selectedPetId: "violet",
    })
    expect(normalizePreferences({ awake: true, selectedPetId: "custom-nova" }, pets)).toEqual({
      awake: true,
      selectedPetId: "custom-nova",
    })
    expect(selectPreference({ awake: true, selectedPetId: "violet" }, "custom-nova", pets)).toEqual({
      selectedPetId: "custom-nova",
    })
  })

  test("keeps wake and tuck as explicit lifecycle requests", async () => {
    const { wakeRequest } = await import("./package/settings/model.js")

    expect(wakeRequest(true)).toEqual({ awake: true })
    expect(wakeRequest(false)).toEqual({ awake: false })
  })

  test("ships a host-scoped custom collection surface without a file input or legacy format", async () => {
    const html = await fs.readFile(new URL("./package/settings/index.html", import.meta.url), "utf8")
    const app = await fs.readFile(new URL("./package/settings/app.js", import.meta.url), "utf8")
    const combined = `${html}\n${app}`

    expect(html).toContain('<script type="module" src="app.js"></script>')
    expect(html).toContain('<link rel="stylesheet" href="styles.css">')
    expect(combined).toMatch(/Add custom pet/)
    expect(combined).toContain('client.request("collection.import"')
    expect(combined).toContain('client.request("collection.delete"')
    expect(combined).not.toMatch(/\bpet\.json\b/i)
    expect(combined).not.toMatch(/<input[^>]+type=["']file|https?:\/\//i)
    expect(app).toMatch(/client\.request\(\s*"preferences\.update"/)
    expect(app).toContain('client.request("lifecycle.setAwake"')
  })
})
