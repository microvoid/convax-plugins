import { animations } from "../assets/activity.js"

export function backgroundPositionFor({ column, row }) {
  return `${(column / 7) * 100}% ${(row / 8) * 100}%`
}

export function frameFor(animation, elapsed, reducedMotion) {
  const definition = animations[animation] ?? animations.idle
  if (reducedMotion) return { column: 0, row: definition.row }
  const duration = definition.durations.reduce((total, value) => total + value, 0)
  let remainder = Math.max(0, elapsed) % duration
  for (let column = 0; column < definition.durations.length; column += 1) {
    if (remainder < definition.durations[column]) return { column, row: definition.row }
    remainder -= definition.durations[column]
  }
  return { column: 0, row: definition.row }
}

function dragPoint(point) {
  return { x: point.screenX, y: point.screenY }
}

export function createDragGesture(onDrag) {
  let origin
  let previous
  let dragging = false
  return {
    end(point) {
      if (!origin) return false
      const wasDragging = dragging
      const current = dragPoint(point)
      if (dragging) onDrag({ dx: current.x - previous.x, dy: current.y - previous.y, phase: "end" })
      origin = undefined
      previous = undefined
      dragging = false
      return wasDragging
    },
    move(point) {
      if (!origin) return false
      const current = dragPoint(point)
      if (!dragging && Math.hypot(current.x - origin.x, current.y - origin.y) >= 4) dragging = true
      if (dragging) onDrag({ dx: current.x - previous.x, dy: current.y - previous.y, phase: "move" })
      previous = current
      return dragging
    },
    start(point) {
      origin = dragPoint(point)
      previous = origin
      dragging = false
    },
  }
}

export function keyAction(key, expanded) {
  if (key === "Enter" || key === " ") return "activate"
  if (key === "Escape" && expanded) return "collapse"
  return "none"
}

export async function activatePet(activityId, { jump, navigate, wait }) {
  if (!activityId) return
  jump()
  await wait()
  await navigate()
}

export async function moveOverlay(client, input) {
  try {
    await client.request("overlay.move", input)
  } catch {
    // Drag feedback is best-effort; the next host snapshot remains authoritative.
  }
}

export function createMoveScheduler(client) {
  let pending
  let flushing

  async function flush() {
    while (pending) {
      const batch = pending
      pending = undefined
      await moveOverlay(client, batch)
    }
  }

  function ensureFlush() {
    if (flushing) return
    flushing = flush().finally(() => {
      flushing = undefined
      if (pending) ensureFlush()
    })
  }

  function push(input) {
    pending = pending
      ? {
          dx: pending.dx + input.dx,
          dy: pending.dy + input.dy,
          phase: pending.phase === "end" || input.phase === "end" ? "end" : "move",
        }
      : { ...input }
    ensureFlush()
  }

  return {
    push,
    async whenIdle() {
      while (flushing || pending) {
        ensureFlush()
        await flushing
      }
    },
  }
}

export async function openActivity(client, activity, revision, { jump, settle, wait }) {
  if (!activity?.id) return
  try {
    await activatePet(activity.id, {
      jump,
      navigate: async () => {
        try {
          await client.request("activity.open", { activityId: activity.id, revision })
        } catch {
          // The overlay remains usable when the target activity disappears.
        }
      },
      wait,
    })
  } finally {
    settle()
  }
}

export async function reconcileExpanded(client, previous, next) {
  try {
    await client.request("overlay.setExpanded", { expanded: next })
    return next
  } catch {
    return previous
  }
}
