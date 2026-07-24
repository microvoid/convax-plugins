const pets = Object.freeze([
  Object.freeze({
    id: "violet",
    displayName: "Violet",
    description: "A pixel companion for Convax.",
    spritesheet: "assets/violet.png",
    spriteVersion: 2,
    alt: "Violet, the Convax pixel companion",
  }),
])

export const petLibrary = Object.freeze({
  schema: "convax.pet-library/1",
  pets,
})

function customPet(value) {
  if (
    !value ||
    value.source !== "custom" ||
    value.spriteVersion !== 2 ||
    !/^custom-[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value.id) ||
    typeof value.displayName !== "string" ||
    typeof value.description !== "string" ||
    typeof value.alt !== "string" ||
    typeof value.spritesheetUrl !== "string"
  ) {
    return undefined
  }
  try {
    const url = new URL(value.spritesheetUrl)
    if (
      url.protocol !== "convax-pet-asset:" ||
      url.hostname !== "pet" ||
      decodeURIComponent(url.pathname) !== `/${value.id}` ||
      url.search ||
      url.hash
    ) {
      return undefined
    }
  } catch {
    return undefined
  }
  return {
    alt: value.alt,
    description: value.description,
    displayName: value.displayName,
    id: value.id,
    source: "custom",
    spritesheetUrl: value.spritesheetUrl,
    spriteVersion: 2,
  }
}

export function petsForCollection(snapshot) {
  const custom = Array.isArray(snapshot?.pets) ? snapshot.pets.map(customPet).filter(Boolean) : []
  const builtin = petLibrary.pets.map((pet) => ({
    ...pet,
    source: "builtin",
    spritesheetUrl: new URL(`./${pet.spritesheet.split("/").at(-1)}`, import.meta.url).href,
  }))
  return [...builtin, ...custom]
}

export function selectedPet(id, availablePets = petLibrary.pets) {
  const pet = availablePets.find((candidate) => candidate.id === id) ?? availablePets[0] ?? petLibrary.pets[0]
  return { ...pet }
}
