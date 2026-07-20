import { describe, expect, test } from "bun:test"
import {
  type BrowserSessionAuthorizationResult,
  XiaoYunqueAuthorizationState,
} from "../src/authorization-state.ts"
import {
  webSessionSchema,
  type StoredWebSession,
  type WebSessionStore,
} from "../src/web-session-store.ts"

const fixedNow = Date.UTC(2026, 6, 19, 0, 0, 0)

function result(value = "new-cookie-value"): BrowserSessionAuthorizationResult {
  return {
    authorizedAt: fixedNow,
    cookies: [{
      domain: "",
      name: "sessionid_pippitcn_web",
      path: "/",
      secure: true,
      value,
    }],
  }
}

function stored(
  value = "old-cookie-value",
  revision = "12345678-1234-1234-9234-123456789abc",
): StoredWebSession {
  return {
    ...result(value),
    revision,
    schema: webSessionSchema,
  }
}

class MemorySessionStore implements WebSessionStore {
  clearCount = 0
  readFailure = false
  value: StoredWebSession | null
  writeHook: ((value: StoredWebSession) => void) | undefined

  constructor(value: StoredWebSession | null) {
    this.value = value
  }

  async clear() {
    this.clearCount += 1
    this.readFailure = false
    this.value = null
  }

  async read() {
    if (this.readFailure) throw new Error("synthetic corrupt session")
    return this.value
  }

  async write(value: StoredWebSession) {
    this.writeHook?.(value)
    this.readFailure = false
    this.value = structuredClone(value)
  }
}

describe("XiaoYunque Cookie authorization state", () => {
  test("publishes the browser session as the sole configured state", async () => {
    const sessions = new MemorySessionStore(null)
    const state = new XiaoYunqueAuthorizationState(sessions)

    await state.replace(result())
    const snapshot = await state.snapshot()

    expect(snapshot.configured).toBeTrue()
    expect(snapshot.session?.cookies[0]?.value).toBe("new-cookie-value")
    expect(await state.session()).toEqual(snapshot.session!)
    expect(await state.isCurrent(snapshot)).toBeTrue()
  })

  test("fails with the public configuration error when no usable session exists", async () => {
    const state = new XiaoYunqueAuthorizationState(new MemorySessionStore(null))

    await expect(state.session()).rejects.toMatchObject({
      name: "XiaoYunqueCredentialConfigurationError",
      publicMessage: expect.stringContaining("Open Convax Services"),
    })

    const expired = stored()
    expired.cookies[0]!.expiresAt = fixedNow - 1
    const expiredState = new XiaoYunqueAuthorizationState(new MemorySessionStore(expired))
    expect(await expiredState.snapshot()).toEqual({ configured: false, session: null })
  })

  test("honors cancellation before returning a session", async () => {
    const state = new XiaoYunqueAuthorizationState(new MemorySessionStore(stored()))
    const controller = new AbortController()
    controller.abort("private-reason")

    await expect(state.session(controller.signal)).rejects.toMatchObject({ name: "AbortError" })
  })

  test("lets a caller cancel while the private session read is still pending", async () => {
    let release!: () => void
    const mayRead = new Promise<void>((resolve) => { release = resolve })
    const state = new XiaoYunqueAuthorizationState({
      clear: async () => undefined,
      read: async () => {
        await mayRead
        return stored()
      },
      write: async () => undefined,
    })
    const controller = new AbortController()
    const reading = state.session(controller.signal)
    controller.abort("private-reason")

    await expect(reading).rejects.toMatchObject({ name: "AbortError" })
    release()
  })

  test("preserves the previous complete session when reauthorization storage fails", async () => {
    const oldSession = stored()
    const sessions = new MemorySessionStore(oldSession)
    sessions.writeHook = () => { throw new Error("synthetic publication failure") }
    const state = new XiaoYunqueAuthorizationState(sessions)

    await expect(state.replace(result())).rejects.toThrow("synthetic publication failure")
    expect(await state.session()).toEqual(oldSession)
  })

  test("treats corrupt or legacy state as disconnected and lets explicit authorization repair it", async () => {
    const sessions = new MemorySessionStore(stored())
    sessions.readFailure = true
    const state = new XiaoYunqueAuthorizationState(sessions)

    expect(await state.snapshot()).toEqual({ configured: false, session: null })
    await state.replace(result("repaired-cookie"))
    expect((await state.session()).cookies[0]?.value).toBe("repaired-cookie")
  })

  test("detects a session replaced after a status snapshot", async () => {
    const state = new XiaoYunqueAuthorizationState(new MemorySessionStore(stored()))
    const oldSnapshot = await state.snapshot()

    await state.replace(result())

    expect(await state.isCurrent(oldSnapshot)).toBeFalse()
    expect(await state.isCurrent(await state.snapshot())).toBeTrue()
  })

  test("sign-out clears the authoritative Cookie session", async () => {
    const sessions = new MemorySessionStore(stored())
    const state = new XiaoYunqueAuthorizationState(sessions)

    await state.clear()

    expect(sessions.clearCount).toBe(1)
    expect(await state.snapshot()).toEqual({ configured: false, session: null })
  })
})
