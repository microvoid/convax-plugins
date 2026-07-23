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

export const petLibrary = Object.freeze({ schema: "convax.pet-library/1", pets })

export function selectedPet(id) {
  const pet = petLibrary.pets.find((candidate) => candidate.id === id) ?? petLibrary.pets[0]
  return { ...pet }
}
