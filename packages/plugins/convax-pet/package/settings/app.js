import { connectPetHost } from "../assets/pet-host.js"
import { petLibrary } from "../assets/pet-library.js"
import { normalizePreferences, selectPreference, wakeRequest } from "model.js"

const root = document.querySelector("#settings-root")
let client
let preferences = normalizePreferences()
let errorMessage = ""

function element(tag, className, text) {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (text !== undefined) node.textContent = text
  return node
}

async function mutate(operation) {
  errorMessage = ""
  try {
    preferences = normalizePreferences(await operation())
  } catch {
    errorMessage = "Pet preferences could not be updated."
  }
  render()
}

function petCard(pet) {
  const selected = pet.id === preferences.selectedPetId
  const button = element("button", selected ? "pet-card pet-card--selected" : "pet-card")
  button.type = "button"
  button.setAttribute("aria-pressed", String(selected))
  button.addEventListener("click", () =>
    void mutate(() => client.request("preferences.update", selectPreference(preferences, pet.id))),
  )
  const preview = element("span", "pet-preview")
  preview.setAttribute("role", "img")
  preview.setAttribute("aria-label", pet.alt)
  preview.style.backgroundImage = `url("${new URL(`../${pet.spritesheet}`, import.meta.url)}")`
  const copy = element("span", "pet-card__copy")
  const title = element("span", "pet-card__title", pet.displayName)
  if (selected) title.append(element("span", "pet-selected", "Selected"))
  copy.append(title, element("span", "pet-card__description", pet.description))
  button.append(preview, copy)
  return button
}

function render() {
  root.replaceChildren()
  const header = element("header", "settings-header")
  const heading = element("div")
  heading.append(
    element("p", "settings-eyebrow", "DESKTOP COMPANION"),
    element("h1", "", "Pets"),
    element("p", "settings-description", "Choose a companion that reflects Agent activity across your projects."),
  )
  const lifecycle = element("button", "lifecycle-button", preferences.awake ? "Tuck away" : "Wake pet")
  lifecycle.type = "button"
  lifecycle.addEventListener("click", () =>
    void mutate(() => client.request("lifecycle.setAwake", wakeRequest(!preferences.awake))),
  )
  header.append(heading, lifecycle)
  const section = element("section", "collection")
  section.setAttribute("aria-label", "Pet collection")
  section.append(element("h2", "", "Pet collection"), element("p", "collection-description", "Selection does not wake a tucked pet."))
  const grid = element("div", "pet-grid")
  grid.append(...petLibrary.pets.map(petCard))
  section.append(grid)
  root.append(header, section)
  if (errorMessage) root.append(element("p", "settings-error", errorMessage))
}

async function start() {
  client = await connectPetHost({ pluginId: "convax-pet", surface: "settings" })
  preferences = normalizePreferences(await client.request("preferences.get", {}))
  client.subscribe("preferences.changed", (next) => {
    preferences = normalizePreferences(next)
    render()
  })
  render()
}

start().catch(() => {
  root.replaceChildren(element("p", "settings-error", "Pet settings are disconnected from Convax."))
})
