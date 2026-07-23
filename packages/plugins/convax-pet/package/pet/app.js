import { animationFor, orderedActivities, statusText } from "../assets/activity.js"
import { connectPetHost } from "../assets/pet-host.js"
import { selectedPet } from "../assets/pet-library.js"
import {
  backgroundPositionFor,
  createDragGesture,
  createMoveScheduler,
  frameFor,
  keyAction,
  openActivity,
  reconcileExpanded,
} from "./model.js"

const root = document.querySelector("#pet-root")
const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)")
let client
let expanded = false
let expansionPending = false
let jumping = false
let moveScheduler
let animationStarted = performance.now()
let animationFrame
let snapshot = { activities: [], preferences: { selectedPetId: "violet" }, revision: 0 }

function element(tag, className, text) {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (text !== undefined) node.textContent = text
  return node
}

function currentAnimation() {
  return jumping ? "jumping" : animationFor(snapshot.activities[0])
}

function paintSprite(sprite) {
  const frame = frameFor(currentAnimation(), performance.now() - animationStarted, reducedMotion.matches)
  sprite.style.backgroundPosition = backgroundPositionFor(frame)
  if (!reducedMotion.matches) animationFrame = requestAnimationFrame(() => paintSprite(sprite))
}

function stopAnimation() {
  if (animationFrame !== undefined) cancelAnimationFrame(animationFrame)
  animationFrame = undefined
}

async function setExpanded(next) {
  if (expansionPending || next === expanded) return
  expansionPending = true
  try {
    const reconciled = await reconcileExpanded(client, expanded, next)
    if (reconciled === expanded) return
    expanded = reconciled
    render()
  } finally {
    expansionPending = false
  }
}

async function navigate(activity) {
  await openActivity(client, activity, snapshot.revision, {
    jump() {
      jumping = true
      animationStarted = performance.now()
      render()
    },
    settle() {
      jumping = false
      animationStarted = performance.now()
      render()
    },
    wait: () => new Promise((resolve) => window.setTimeout(resolve, reducedMotion.matches ? 0 : 180)),
  })
}

function activityRow(activity) {
  const button = element("button", "pet-activity")
  button.type = "button"
  button.addEventListener("click", () => void navigate(activity))
  const dot = element("span", `pet-dot pet-dot--${activity.state}`)
  dot.setAttribute("aria-hidden", "true")
  const copy = element("span", "pet-activity__copy")
  copy.append(element("strong", "", activity.sessionLabel), element("span", "", activity.projectLabel))
  button.append(dot, copy, element("span", "pet-activity__status", statusText(activity)))
  return button
}

function render() {
  stopAnimation()
  root.replaceChildren()
  root.className = expanded ? "pet-shell pet-shell--expanded" : "pet-shell"
  const activities = orderedActivities(snapshot.activities)
  const primary = activities[0]
  const pet = selectedPet(snapshot.preferences.selectedPetId)

  if (expanded) {
    const tray = element("section", "pet-tray")
    tray.setAttribute("aria-label", "Agent activity")
    const header = element("header", "pet-tray__header")
    const heading = element("div")
    heading.append(element("p", "pet-eyebrow", "Convax companion"), element("h1", "", pet.displayName))
    const close = element("button", "pet-icon-button", "×")
    close.type = "button"
    close.setAttribute("aria-label", "Close activity tray")
    close.addEventListener("click", () => void setExpanded(false))
    header.append(heading, close)
    const list = element("div", "pet-activity-list")
    if (activities.length) list.append(...activities.map(activityRow))
    else list.append(element("p", "pet-empty", `All caught up. ${pet.displayName} is keeping watch.`))
    tray.append(header, list)
    root.append(tray)
  }

  const stage = element("div", "pet-stage")
  const spriteButton = element("button", "pet-sprite-button")
  spriteButton.type = "button"
  spriteButton.tabIndex = expanded ? 0 : -1
  spriteButton.title = primary ? statusText(primary) : pet.description
  spriteButton.setAttribute("aria-label", primary ? `${pet.displayName}: ${statusText(primary)}` : pet.alt)
  const sprite = element("span", "pet-sprite")
  sprite.setAttribute("aria-hidden", "true")
  sprite.style.backgroundImage = `url("${new URL(`../${pet.spritesheet}`, import.meta.url)}")`
  spriteButton.append(sprite)
  const drag = createDragGesture(moveScheduler.push)
  let dragged = false
  spriteButton.addEventListener("pointerdown", (event) => {
    dragged = false
    spriteButton.setPointerCapture(event.pointerId)
    drag.start(event)
  })
  spriteButton.addEventListener("pointermove", (event) => {
    dragged = drag.move(event) || dragged
  })
  spriteButton.addEventListener("pointerup", (event) => {
    dragged = drag.end(event) || dragged
  })
  spriteButton.addEventListener("click", () => {
    if (!dragged && primary) void navigate(primary)
  })
  spriteButton.addEventListener("keydown", (event) => {
    const action = keyAction(event.key, expanded)
    if (action === "activate" && primary) {
      event.preventDefault()
      void navigate(primary)
    } else if (action === "collapse") {
      event.preventDefault()
      void setExpanded(false)
    }
  })
  const toggle = element("button", `pet-tray-toggle pet-tray-toggle--${primary?.state ?? "idle"}`, primary ? statusText(primary) : "Idle")
  toggle.type = "button"
  toggle.setAttribute("aria-expanded", String(expanded))
  toggle.addEventListener("click", () => void setExpanded(!expanded))
  stage.append(spriteButton, toggle)
  root.append(stage)
  animationStarted = performance.now()
  paintSprite(sprite)
}

async function start() {
  client = await connectPetHost({ pluginId: "convax-pet", surface: "overlay" })
  moveScheduler = createMoveScheduler(client)
  const initial = await client.request("activity.getSnapshot", {})
  const preferences = await client.request("preferences.get", {})
  snapshot = { ...initial, activities: orderedActivities(initial.activities), preferences }
  client.subscribe("activity.changed", (next) => {
    if (next.revision < snapshot.revision) return
    snapshot = { ...snapshot, ...next, activities: orderedActivities(next.activities) }
    render()
  })
  client.subscribe("preferences.changed", (preferencesNext) => {
    snapshot = { ...snapshot, preferences: preferencesNext }
    render()
  })
  reducedMotion.addEventListener("change", render)
  render()
}

start().catch(() => {
  root.replaceChildren(element("p", "pet-disconnected", "Pet host unavailable"))
})
