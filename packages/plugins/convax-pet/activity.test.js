import { describe, expect, test } from "bun:test"

const activity = (id, state, updatedAt, subtype = "none") => ({ id, state, subtype, updatedAt })

describe("pet activity presentation", () => {
  test("orders exact state priority before recency", async () => {
    const { orderedActivities } = await import("./package/assets/activity.js")
    const input = [
      activity("running", "running", 50),
      activity("ready", "ready", 40),
      activity("blocked", "blocked", 30),
      activity("input-old", "needs-input", 10, "question"),
      activity("input-new", "needs-input", 20, "permission"),
    ]

    expect(orderedActivities(input).map(({ id }) => id)).toEqual([
      "input-new",
      "input-old",
      "blocked",
      "ready",
      "running",
    ])
    expect(input.map(({ id }) => id)).toEqual(["running", "ready", "blocked", "input-old", "input-new"])
  })

  test("maps normalized activity to atlas animations", async () => {
    const { animationFor } = await import("./package/assets/activity.js")

    expect(animationFor()).toBe("idle")
    expect(animationFor(activity("question", "needs-input", 1, "question"))).toBe("waiting")
    expect(animationFor(activity("permission", "needs-input", 1, "permission"))).toBe("review")
    expect(animationFor(activity("blocked", "blocked", 1))).toBe("failed")
    expect(animationFor(activity("ready", "ready", 1))).toBe("waving")
    expect(animationFor(activity("running", "running", 1))).toBe("running")
  })

  test("defines all nine fixed atlas rows and bounded status copy", async () => {
    const { animations, statusText } = await import("./package/assets/activity.js")

    expect(Object.keys(animations)).toEqual([
      "idle",
      "running-right",
      "running-left",
      "waving",
      "jumping",
      "failed",
      "waiting",
      "running",
      "review",
    ])
    expect(statusText(activity("permission", "needs-input", 1, "permission"))).toBe("Needs permission")
    expect(statusText(activity("question", "needs-input", 1, "question"))).toBe("Needs an answer")
    expect(statusText(activity("blocked", "blocked", 1))).toBe("Blocked")
    expect(statusText(activity("ready", "ready", 1))).toBe("Ready")
    expect(statusText(activity("running", "running", 1))).toBe("Running")
  })
})
