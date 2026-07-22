import { describe, expect, mock, test } from "bun:test"
import fs from "node:fs/promises"

describe("Plugin-owned pet overlay", () => {
  test("selects atlas frames and holds the first frame for reduced motion", async () => {
    const { frameFor } = await import("./package/pet/model.js")

    expect(frameFor("idle", 0, false)).toEqual({ column: 0, row: 0 })
    expect(frameFor("idle", 300, false)).toEqual({ column: 1, row: 0 })
    expect(frameFor("review", 5_000, true)).toEqual({ column: 0, row: 8 })
  })

  test("distinguishes click from a four-pixel drag", async () => {
    const { createDragGesture } = await import("./package/pet/model.js")
    const onDrag = mock(() => undefined)
    const gesture = createDragGesture(onDrag)

    gesture.start({ clientX: 10, clientY: 10 })
    expect(gesture.move({ clientX: 12, clientY: 12 })).toBe(false)
    expect(gesture.end({ clientX: 12, clientY: 12 })).toBe(false)
    gesture.start({ clientX: 10, clientY: 10 })
    expect(gesture.move({ clientX: 15, clientY: 10 })).toBe(true)
    expect(gesture.end({ clientX: 18, clientY: 8 })).toBe(true)
    expect(onDrag).toHaveBeenCalledWith({ dx: 5, dy: 0, phase: "move" })
    expect(onDrag).toHaveBeenCalledWith({ dx: 3, dy: -2, phase: "end" })
  })

  test("supports keyboard actions and jump-before-navigation", async () => {
    const { activatePet, keyAction } = await import("./package/pet/model.js")
    const calls = []

    expect(keyAction("Enter", false)).toBe("activate")
    expect(keyAction(" ", true)).toBe("activate")
    expect(keyAction("Escape", true)).toBe("collapse")
    expect(keyAction("Escape", false)).toBe("none")
    await activatePet("activity-one", {
      jump: () => calls.push("jump"),
      navigate: async () => calls.push("navigate"),
      wait: async () => calls.push("wait"),
    })
    expect(calls).toEqual(["jump", "wait", "navigate"])
  })

  test("ships only local sandbox-compatible surface dependencies", async () => {
    const html = await fs.readFile(new URL("./package/pet/index.html", import.meta.url), "utf8")
    const app = await fs.readFile(new URL("./package/pet/app.js", import.meta.url), "utf8")

    expect(html).toContain('<script type="module" src="app.js"></script>')
    expect(html).toContain('<link rel="stylesheet" href="styles.css">')
    expect(html).not.toMatch(/https?:\/\/|<form|<webview|<script(?! type="module" src="app\.js")/)
    expect(app).not.toMatch(/\b(?:require|process|electron|node:|fetch|XMLHttpRequest|WebSocket)\b/)
  })
})
