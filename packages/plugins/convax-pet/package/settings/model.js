import { selectedPet } from "../assets/pet-library.js"

export function normalizePreferences(value) {
  return {
    awake: value?.awake === true,
    selectedPetId: selectedPet(value?.selectedPetId).id,
  }
}

export function selectPreference(_current, selectedPetId) {
  return { selectedPetId: selectedPet(selectedPetId).id }
}

export function wakeRequest(awake) {
  return { awake: awake === true }
}
