import { selectedPet } from "../assets/pet-library.js"

export function normalizePreferences(value, pets) {
  return {
    awake: value?.awake === true,
    selectedPetId: selectedPet(value?.selectedPetId, pets).id,
  }
}

export function selectPreference(_current, selectedPetId, pets) {
  return { selectedPetId: selectedPet(selectedPetId, pets).id }
}

export function wakeRequest(awake) {
  return { awake: awake === true }
}
