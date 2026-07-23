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
})
