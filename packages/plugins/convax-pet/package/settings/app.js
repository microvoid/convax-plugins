import { connectPetHost } from "../assets/pet-host.js"
import { petsForCollection, selectedPet } from "../assets/pet-library.js"
import { normalizePreferences, selectPreference, wakeRequest } from "./model.js"

const root = document.querySelector("#settings-root")
let busyAction = ""
let client
let collection = { pets: [], revision: 0 }
let errorMessage = ""
let pendingRemoval = ""
let preferences = normalizePreferences()

function element(tag, className, text) {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (text !== undefined) node.textContent = text
  return node
}

function availablePets() {
  return petsForCollection(collection)
}

function sprite(pet, className) {
  const preview = element("span", className)
  preview.setAttribute("role", "img")
  preview.setAttribute("aria-label", pet.alt)
  preview.style.backgroundImage = `url("${pet.spritesheetUrl}")`
  return preview
}

async function perform(action, failureMessage, operation) {
  if (busyAction) return
  busyAction = action
  errorMessage = ""
  render()
  try {
    await operation()
  } catch {
    errorMessage = failureMessage
  } finally {
    busyAction = ""
    render()
  }
}

function selectPet(pet) {
  void perform(`select-${pet.id}`, "This companion could not be selected.", async () => {
    const next = await client.request("preferences.update", selectPreference(preferences, pet.id, availablePets()))
    preferences = normalizePreferences(next, availablePets())
  })
}

function toggleLifecycle() {
  void perform("lifecycle", "The pet window could not be updated.", async () => {
    const next = await client.request("lifecycle.setAwake", wakeRequest(!preferences.awake))
    preferences = normalizePreferences(next, availablePets())
  })
}

function importPet() {
  void perform("import", "That atlas could not be added. Use a transparent 1536 × 1872 PNG or WebP.", async () => {
    const imported = await client.request("collection.import", {})
    if (!imported) return
    collection = await client.request("collection.get", {})
    const next = await client.request("preferences.update", selectPreference(preferences, imported.id, availablePets()))
    preferences = normalizePreferences(next, availablePets())
  })
}

function removePet(pet) {
  if (pendingRemoval !== pet.id) {
    pendingRemoval = pet.id
    render()
    return
  }
  void perform(`remove-${pet.id}`, "This custom companion could not be removed.", async () => {
    collection = await client.request("collection.delete", { petId: pet.id })
    pendingRemoval = ""
    if (preferences.selectedPetId === pet.id) {
      const fallback = availablePets()[0]
      const next = await client.request(
        "preferences.update",
        selectPreference(preferences, fallback.id, availablePets()),
      )
      preferences = normalizePreferences(next, availablePets())
    } else {
      preferences = normalizePreferences(preferences, availablePets())
    }
  })
}

function petCard(pet) {
  const selected = pet.id === preferences.selectedPetId
  const card = element("article", selected ? "pet-card pet-card--selected" : "pet-card")
  const select = element("button", "pet-card__select")
  select.type = "button"
  select.disabled = Boolean(busyAction)
  select.setAttribute("aria-pressed", String(selected))
  select.addEventListener("click", () => selectPet(pet))

  const copy = element("span", "pet-card__copy")
  const title = element("span", "pet-card__title")
  title.append(element("strong", "", pet.displayName))
  title.append(element("span", `pet-source pet-source--${pet.source}`, pet.source === "custom" ? "Custom" : "Original"))
  copy.append(title, element("span", "pet-card__description", pet.description))
  select.append(sprite(pet, "pet-preview"), copy)
  card.append(select)

  const footer = element("footer", "pet-card__footer")
  footer.append(element("span", "", selected ? "Current companion" : "Ready to select"))
  if (pet.source === "custom") {
    const remove = element(
      "button",
      pendingRemoval === pet.id ? "remove-button remove-button--confirm" : "remove-button",
      pendingRemoval === pet.id ? "Confirm remove" : "Remove",
    )
    remove.type = "button"
    remove.disabled = Boolean(busyAction)
    remove.addEventListener("click", () => removePet(pet))
    footer.append(remove)
  }
  card.append(footer)
  return card
}

function render() {
  root.replaceChildren()
  const pets = availablePets()
  preferences = normalizePreferences(preferences, pets)
  const current = selectedPet(preferences.selectedPetId, pets)

  const header = element("header", "studio-header")
  const heading = element("div", "studio-heading")
  heading.append(
    element("p", "settings-eyebrow", "DESKTOP COMPANION"),
    element("h1", "", "Pet Studio"),
    element("p", "settings-description", "Choose a companion for Agent activity, or bring your own pixel atlas."),
  )
  header.append(heading)

  const hero = element("section", "current-pet")
  hero.setAttribute("aria-label", "Current companion")
  const heroPreview = element("div", "current-pet__preview")
  heroPreview.append(sprite(current, "pet-preview pet-preview--hero"))
  const heroCopy = element("div", "current-pet__copy")
  const state = element(
    "span",
    preferences.awake ? "pet-state pet-state--awake" : "pet-state",
    preferences.awake ? "ON DUTY" : "TUCKED AWAY",
  )
  heroCopy.append(state, element("h2", "", current.displayName), element("p", "", current.description))
  const lifecycle = element(
    "button",
    preferences.awake ? "primary-button primary-button--quiet" : "primary-button",
    preferences.awake ? "Tuck away" : "Wake pet",
  )
  lifecycle.type = "button"
  lifecycle.disabled = Boolean(busyAction)
  lifecycle.addEventListener("click", toggleLifecycle)
  heroCopy.append(lifecycle)
  hero.append(heroPreview, heroCopy)

  const section = element("section", "collection")
  section.setAttribute("aria-label", "Pet collection")
  const collectionHeader = element("header", "collection-header")
  const collectionCopy = element("div")
  collectionCopy.append(
    element("p", "section-kicker", `${pets.length} COMPANION${pets.length === 1 ? "" : "S"}`),
    element("h2", "", "Your collection"),
    element("p", "collection-description", "Selection does not wake a tucked pet."),
  )
  const addGroup = element("div", "add-group")
  const add = element("button", "add-button", busyAction === "import" ? "Opening…" : "Add custom pet")
  add.type = "button"
  add.disabled = Boolean(busyAction)
  add.addEventListener("click", importPet)
  addGroup.append(add, element("span", "format-hint", "PNG or WebP · transparent · 1536 × 1872"))
  collectionHeader.append(collectionCopy, addGroup)

  const grid = element("div", "pet-grid")
  grid.append(...pets.map(petCard))
  section.append(collectionHeader, grid)

  root.append(header, hero, section)
  if (busyAction) {
    const status = element("p", "settings-status", "Updating your Pet Studio…")
    status.setAttribute("aria-live", "polite")
    root.append(status)
  }
  if (errorMessage) {
    const error = element("p", "settings-error", errorMessage)
    error.setAttribute("role", "alert")
    root.append(error)
  }
}

async function start() {
  client = await connectPetHost({
    pluginId: "convax-pet",
    surface: "settings",
  })
  const [initialPreferences, initialCollection] = await Promise.all([
    client.request("preferences.get", {}),
    client.request("collection.get", {}),
  ])
  collection = initialCollection
  preferences = normalizePreferences(initialPreferences, availablePets())
  client.subscribe("preferences.changed", (next) => {
    preferences = normalizePreferences(next, availablePets())
    render()
  })
  client.subscribe("collection.changed", (next) => {
    if (next.revision < collection.revision) return
    collection = next
    preferences = normalizePreferences(preferences, availablePets())
    render()
  })
  render()
}

start().catch(() => {
  root.replaceChildren(element("p", "settings-error", "Pet Studio is disconnected from Convax."))
})
