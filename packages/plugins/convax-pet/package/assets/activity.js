export const priority = Object.freeze({ "needs-input": 0, blocked: 1, ready: 2, running: 3 })

export const animations = Object.freeze({
  idle: Object.freeze({ durations: Object.freeze([280, 110, 110, 140, 140, 320]), row: 0 }),
  "running-right": Object.freeze({ durations: Object.freeze([120, 120, 120, 120, 120, 120, 120, 220]), row: 1 }),
  "running-left": Object.freeze({ durations: Object.freeze([120, 120, 120, 120, 120, 120, 120, 220]), row: 2 }),
  waving: Object.freeze({ durations: Object.freeze([140, 120, 120, 120, 120, 120, 160, 260]), row: 3 }),
  jumping: Object.freeze({ durations: Object.freeze([90, 90, 90, 110, 110, 120, 140, 220]), row: 4 }),
  failed: Object.freeze({ durations: Object.freeze([180, 180, 180, 180, 180, 180, 180, 300]), row: 5 }),
  waiting: Object.freeze({ durations: Object.freeze([160, 160, 160, 160, 160, 160, 160, 260]), row: 6 }),
  running: Object.freeze({ durations: Object.freeze([120, 120, 120, 120, 120, 120, 120, 220]), row: 7 }),
  review: Object.freeze({ durations: Object.freeze([180, 180, 180, 180, 180, 180, 180, 300]), row: 8 }),
})

export function orderedActivities(activities) {
  return [...activities].sort(
    (left, right) =>
      (priority[left.state] ?? Number.MAX_SAFE_INTEGER) - (priority[right.state] ?? Number.MAX_SAFE_INTEGER) ||
      right.updatedAt - left.updatedAt ||
      left.id.localeCompare(right.id),
  )
}

export function animationFor(activity) {
  if (!activity) return "idle"
  if (activity.state === "needs-input") return activity.subtype === "permission" ? "review" : "waiting"
  if (activity.state === "blocked") return "failed"
  if (activity.state === "ready") return "waving"
  return "running"
}

export function statusText(activity) {
  if (activity.state === "needs-input") return activity.subtype === "permission" ? "Needs permission" : "Needs an answer"
  if (activity.state === "blocked") return "Blocked"
  if (activity.state === "ready") return "Ready"
  return "Running"
}
