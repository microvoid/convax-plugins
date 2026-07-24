import { describe, expect, mock, test } from "bun:test"
import fs from "node:fs/promises"

describe("Plugin-owned pet overlay", () => {
  test("selects atlas frames and holds the first frame for reduced motion", async () => {
    const { frameFor } = await import("./package/pet/model.js")

    expect(frameFor("idle", 0, false)).toEqual({ column: 0, row: 0 })
    expect(frameFor("idle", 300, false)).toEqual({ column: 1, row: 0 })
    expect(frameFor("review", 5_000, true)).toEqual({ column: 0, row: 8 })
  })

  test("maps atlas cells to normalized CSS background positions", async () => {
    const { backgroundPositionFor } = await import("./package/pet/model.js")

    expect(backgroundPositionFor({ column: 3, row: 4 })).toBe(`${300 / 7}% 50%`)
    expect(backgroundPositionFor({ column: 7, row: 8 })).toBe("100% 100%")
  })

  test("distinguishes click from a four-pixel drag", async () => {
    const { createDragGesture } = await import("./package/pet/model.js")
    const onDrag = mock(() => undefined)
    const gesture = createDragGesture(onDrag, {
      createSession: () => "drag-one",
    })

    gesture.start({ clientX: 10, clientY: 10, screenX: 110, screenY: 210 })
    expect(gesture.move({ clientX: 12, clientY: 12, screenX: 112, screenY: 212 })).toBe(false)
    expect(gesture.end({ clientX: 12, clientY: 12, screenX: 112, screenY: 212 })).toBe(false)
    gesture.start({ clientX: 10, clientY: 10, screenX: 110, screenY: 210 })
    expect(gesture.move({ clientX: 15, clientY: 10, screenX: 115, screenY: 210 })).toBe(true)
    expect(gesture.end({ clientX: 18, clientY: 8, screenX: 118, screenY: 208 })).toBe(true)
    expect(onDrag).toHaveBeenNthCalledWith(1, {
      phase: "start",
      screenX: 110,
      screenY: 210,
      sequence: 0,
      session: "drag-one",
    })
    expect(onDrag).toHaveBeenNthCalledWith(2, {
      phase: "end",
      screenX: 112,
      screenY: 212,
      sequence: 1,
      session: "drag-one",
    })
    expect(onDrag).toHaveBeenNthCalledWith(3, {
      phase: "start",
      screenX: 110,
      screenY: 210,
      sequence: 0,
      session: "drag-one",
    })
    expect(onDrag).toHaveBeenNthCalledWith(4, {
      phase: "move",
      screenX: 115,
      screenY: 210,
      sequence: 1,
      session: "drag-one",
    })
    expect(onDrag).toHaveBeenNthCalledWith(5, {
      phase: "end",
      screenX: 118,
      screenY: 208,
      sequence: 2,
      session: "drag-one",
    })
  })

  test("uses stable screen coordinates while the native window moves", async () => {
    const { createDragGesture } = await import("./package/pet/model.js")
    const onDrag = mock(() => undefined)
    const gesture = createDragGesture(onDrag, {
      createSession: () => "drag-two",
    })

    gesture.start({ clientX: 80, clientY: 50, screenX: 500, screenY: 300 })
    expect(gesture.move({ clientX: 20, clientY: 50, screenX: 506, screenY: 300 })).toBe(true)
    expect(gesture.end({ clientX: 18, clientY: 48, screenX: 509, screenY: 298 })).toBe(true)

    expect(onDrag).toHaveBeenNthCalledWith(2, {
      phase: "move",
      screenX: 506,
      screenY: 300,
      sequence: 1,
      session: "drag-two",
    })
    expect(onDrag).toHaveBeenNthCalledWith(3, {
      phase: "end",
      screenX: 509,
      screenY: 298,
      sequence: 2,
      session: "drag-two",
    })
  })

  test("sends the latest absolute pointer frame without waiting for older host responses", async () => {
    const { createMoveScheduler } = await import("./package/pet/model.js")
    const releases = []
    const scheduled = []
    const client = {
      request: mock(
        () =>
          new Promise((resolve) => {
            releases.push(resolve)
          }),
      ),
    }
    const scheduler = createMoveScheduler(client, {
      cancel: (id) => {
        scheduled[id] = undefined
      },
      schedule: (callback) => {
        scheduled.push(callback)
        return scheduled.length - 1
      },
    })

    scheduler.push({
      phase: "start",
      screenX: 100,
      screenY: 200,
      sequence: 0,
      session: "drag-one",
    })
    scheduler.push({
      phase: "move",
      screenX: 102,
      screenY: 201,
      sequence: 1,
      session: "drag-one",
    })
    scheduler.push({
      phase: "move",
      screenX: 105,
      screenY: 199,
      sequence: 2,
      session: "drag-one",
    })
    expect(client.request).toHaveBeenCalledTimes(1)

    scheduled[0]?.()
    expect(client.request).toHaveBeenCalledTimes(2)
    scheduler.push({
      phase: "end",
      screenX: 109,
      screenY: 202,
      sequence: 3,
      session: "drag-one",
    })
    expect(client.request).toHaveBeenCalledTimes(3)

    releases.splice(0).forEach((release) => release())
    await scheduler.whenIdle()

    expect(client.request).toHaveBeenNthCalledWith(1, "overlay.move", {
      phase: "start",
      screenX: 100,
      screenY: 200,
      sequence: 0,
      session: "drag-one",
    })
    expect(client.request).toHaveBeenNthCalledWith(2, "overlay.move", {
      phase: "move",
      screenX: 105,
      screenY: 199,
      sequence: 2,
      session: "drag-one",
    })
    expect(client.request).toHaveBeenNthCalledWith(3, "overlay.move", {
      phase: "end",
      screenX: 109,
      screenY: 202,
      sequence: 3,
      session: "drag-one",
    })
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

  test("contains activity.open failures and always resets jumping", async () => {
    const { openActivity } = await import("./package/pet/model.js")
    const client = {
      request: mock(() => Promise.reject(new Error("host unavailable"))),
    }
    const calls = []

    await expect(
      openActivity(client, { id: "activity-one" }, 7, {
        jump: () => calls.push("jump"),
        settle: () => calls.push("settle"),
        wait: async () => calls.push("wait"),
      }),
    ).resolves.toBeUndefined()

    expect(client.request).toHaveBeenCalledWith("activity.open", {
      activityId: "activity-one",
      revision: 7,
    })
    expect(calls).toEqual(["jump", "wait", "settle"])
  })

  test("reconciles failed expansion requests to the previous state", async () => {
    const { reconcileExpanded } = await import("./package/pet/model.js")
    const client = {
      request: mock(() => Promise.reject(new Error("host unavailable"))),
    }

    await expect(reconcileExpanded(client, false, true)).resolves.toBe(false)
    expect(client.request).toHaveBeenCalledWith("overlay.setExpanded", {
      expanded: true,
    })
  })

  test("contains overlay.move failures", async () => {
    const { moveOverlay } = await import("./package/pet/model.js")
    const client = {
      request: mock(() => Promise.reject(new Error("host unavailable"))),
    }
    const input = {
      phase: "move",
      screenX: 404,
      screenY: 198,
      sequence: 2,
      session: "drag-one",
    }

    await expect(moveOverlay(client, input)).resolves.toBeUndefined()
    expect(client.request).toHaveBeenCalledWith("overlay.move", input)
  })

  test("ships only local sandbox-compatible surface dependencies", async () => {
    const html = await fs.readFile(new URL("./package/pet/index.html", import.meta.url), "utf8")
    const app = await fs.readFile(new URL("./package/pet/app.js", import.meta.url), "utf8")

    expect(html).toContain('<script type="module" src="app.js"></script>')
    expect(html).toContain('<link rel="stylesheet" href="styles.css">')
    expect(html).not.toMatch(/https?:\/\/|<form|<webview|<script(?! type="module" src="app\.js")/)
    expect(app).not.toMatch(/\b(?:require|process|electron|node:|fetch|XMLHttpRequest|WebSocket)\b/)
    expect(app).toMatch(
      /const reconciled = await reconcileExpanded\(client, expanded, next\)[\s\S]*?expanded = reconciled[\s\S]*?render\(\)/,
    )
    expect(app).not.toMatch(/expanded = next\s+render\(\)/)
  })
})
