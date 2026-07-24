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

let nextDragSession = 1

function createDragSession() {
  const session = `drag-${Date.now().toString(36)}-${nextDragSession.toString(36)}`
  nextDragSession += 1
  return session
}

export function createDragGesture(onDrag, { createSession = createDragSession } = {}) {
  let origin
  let sequence = 0
  let session
  let dragging = false
  const emit = (phase, point) => {
    const current = dragPoint(point)
    onDrag({
      phase,
      screenX: current.x,
      screenY: current.y,
      sequence,
      session,
    })
    sequence += 1
  }
  return {
    end(point) {
      if (!origin) return false
      const wasDragging = dragging
      emit("end", point)
      origin = undefined
      session = undefined
      dragging = false
      return wasDragging
    },
    move(point) {
      if (!origin) return false
      const current = dragPoint(point)
      if (!dragging && Math.hypot(current.x - origin.x, current.y - origin.y) >= 4) dragging = true
      if (dragging) emit("move", point)
      return dragging
    },
    start(point) {
      origin = dragPoint(point)
      session = createSession()
      sequence = 0
      dragging = false
      emit("start", point)
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

export function createMoveScheduler(
  client,
  { cancel = (id) => cancelAnimationFrame(id), schedule = (callback) => requestAnimationFrame(callback) } = {},
) {
  const active = new Set()
  let pendingMove
  let scheduled

  function send(input) {
    const request = moveOverlay(client, input)
    active.add(request)
    void request.finally(() => active.delete(request))
  }

  function flush() {
    scheduled = undefined
    if (!pendingMove) return
    const input = pendingMove
    pendingMove = undefined
    send(input)
  }

  function push(input) {
    if (input.phase === "move") {
      pendingMove = { ...input }
      if (scheduled === undefined) scheduled = schedule(flush)
      return
    }
    if (input.phase === "end" && scheduled !== undefined) {
      cancel(scheduled)
      scheduled = undefined
      flush()
    }
    send(input)
  }

  return {
    push,
    async whenIdle() {
      if (scheduled !== undefined) {
        cancel(scheduled)
        scheduled = undefined
        flush()
      }
      while (active.size) await Promise.all([...active])
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
          await client.request("activity.open", {
            activityId: activity.id,
            revision,
          })
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
