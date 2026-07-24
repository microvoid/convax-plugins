import { describe, expect, test } from "bun:test"
import fs from "node:fs/promises"

describe("packaged pet library", () => {
  test("matches the inert JSON source and resolves a safe selection", async () => {
    const module = await import("./package/assets/pet-library.js")
    const json = JSON.parse(await fs.readFile(new URL("./package/pet-library.json", import.meta.url), "utf8"))

    expect(module.petLibrary).toEqual(json)
    expect(json.pets.map((pet) => pet.spritesheet)).toEqual(["assets/violet.png"])
    expect(module.selectedPet("violet").id).toBe("violet")
    expect(module.selectedPet("missing").id).toBe("violet")
  })

  test("does not expose mutable shared library data", async () => {
    const { petLibrary, selectedPet } = await import("./package/assets/pet-library.js")

    expect(Object.isFrozen(petLibrary)).toBe(true)
    expect(Object.isFrozen(petLibrary.pets)).toBe(true)
    expect(Object.isFrozen(petLibrary.pets[0])).toBe(true)
    expect(selectedPet("violet")).not.toBe(petLibrary.pets[0])
  })

  test("merges only canonical managed custom pets with the packaged collection", async () => {
    const { petsForCollection, selectedPet } = await import("./package/assets/pet-library.js")
    const custom = {
      alt: "Nova",
      description: "A local custom companion.",
      displayName: "Nova",
      id: "custom-nova",
      source: "custom",
      spritesheetUrl: "convax-pet-asset://pet/custom-nova",
      spriteVersion: 2,
    }
    const pets = petsForCollection({
      pets: [custom, { ...custom, id: "custom-bad", spritesheetUrl: "file:///private/bad.png" }],
      revision: 1,
    })

    expect(pets.map((pet) => pet.id)).toEqual(["violet", "custom-nova"])
    expect(selectedPet("custom-nova", pets)).toMatchObject(custom)
    expect(pets[0].spritesheetUrl).toEndWith("/assets/violet.png")
  })
})
