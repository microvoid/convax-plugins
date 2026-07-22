import { animations } from "../assets/activity.js"

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

export function createDragGesture(onDrag) {
  let origin
  let previous
  let dragging = false
  return {
    end(point) {
      if (!origin) return false
      const wasDragging = dragging
      if (dragging) onDrag({ dx: point.clientX - previous.clientX, dy: point.clientY - previous.clientY, phase: "end" })
      origin = undefined
      previous = undefined
      dragging = false
      return wasDragging
    },
    move(point) {
      if (!origin) return false
      if (!dragging && Math.hypot(point.clientX - origin.clientX, point.clientY - origin.clientY) >= 4) dragging = true
      if (dragging) onDrag({ dx: point.clientX - previous.clientX, dy: point.clientY - previous.clientY, phase: "move" })
      previous = point
      return dragging
    },
    start(point) {
      origin = point
      previous = point
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
