import { constants } from "node:fs"

function requireNoFollowFlag() {
  const value = constants.O_NOFOLLOW as number | undefined
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value === 0) {
    throw new Error("Secure no-follow file creation is unavailable on this platform")
  }
  return value
}

export function exclusiveNoFollowWriteFlags() {
  return constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | requireNoFollowFlag()
}

export function noFollowReadFlags() {
  return constants.O_RDONLY | requireNoFollowFlag()
}
