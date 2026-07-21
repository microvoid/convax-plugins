import { describe, expect, test } from "bun:test"
import type {
  AuthorizationSnapshot,
  AuthorizationStateController,
  BrowserSessionAuthorizationResult,
} from "../src/authorization-state.ts"
import {
  pluginServiceBrowserAuthorizationCompletionSchema,
  pluginServiceBrowserAuthorizationSchema,
  pluginServiceStatusSchema,
  type PluginServiceBrowserAuthorizationCompletion,
} from "../src/contracts.ts"
import { XiaoYunqueCredentialConfigurationError } from "../src/configuration-error.ts"
import { XiaoYunquePluginService } from "../src/plugin-service.ts"
import {
  XiaoYunqueServiceSessionExpiredError,
  type XiaoYunqueServiceMetadataReader,
} from "../src/service-metadata.ts"
import { webSessionSchema, type StoredWebSession } from "../src/web-session-store.ts"

const fixedNow = Date.UTC(2026, 6, 19, 0, 0, 0)
const authorizationId = "authorization_1234567890-safe"
const oldCookie = "old-service-cookie-never-rendered"
const newCookie = "new-service-cookie-never-rendered"

function storedSession(value: string, revision: number): StoredWebSession {
  return {
    authorizedAt: fixedNow,
    cookies: [{ domain: "", name: "sessionid_pippitcn_web", path: "/", secure: true, value }],
    revision: `12345678-1234-1234-9234-${String(revision).padStart(12, "0")}`,
    schema: webSessionSchema,
  }
}

class MemoryAuthorizationState implements AuthorizationStateController {
  clearEvents: string[] = []
  currentSession: StoredWebSession | null
  failNextReplace = false
  replaceCount = 0
  revision = 1

  constructor(configured: boolean) {
    this.currentSession = configured ? storedSession(oldCookie, this.revision) : null
  }

  async clear() {
    this.clearEvents.push("clear")
    this.currentSession = null
  }

  async isCurrent(snapshot: AuthorizationSnapshot) {
    return snapshot.configured === (this.currentSession !== null)
      && snapshot.session?.revision === this.currentSession?.revision
  }

  async replace(result: BrowserSessionAuthorizationResult) {
    this.replaceCount += 1
    if (this.failNextReplace) {
      this.failNextReplace = false
      throw new Error("synthetic private-store failure")
    }
    this.revision += 1
    this.currentSession = {
      authorizedAt: result.authorizedAt,
      cookies: structuredClone(result.cookies),
      revision: `12345678-1234-1234-9234-${String(this.revision).padStart(12, "0")}`,
      schema: webSessionSchema,
    }
  }

  async session() {
    if (!this.currentSession) {
      throw new XiaoYunqueCredentialConfigurationError(
        "XiaoYunque is not authorized. Open Convax Services and authorize XiaoYunque before generating.",
      )
    }
    return this.currentSession
  }

  async snapshot(): Promise<AuthorizationSnapshot> {
    return {
      configured: this.currentSession !== null,
      session: this.currentSession,
    }
  }
}

const connectedMetadata: XiaoYunqueServiceMetadataReader = {
  read: async () => ({ consumed: 12, displayName: "小云雀测试账号", remaining: 345 }),
}

function completion(
  requestId = authorizationId,
  cookies: PluginServiceBrowserAuthorizationCompletion["cookies"] = [{
    name: "sessionid_pippitcn_web",
    value: newCookie,
  }],
): PluginServiceBrowserAuthorizationCompletion {
  return {
    authorization_id: requestId,
    cookie_origin: "https://xyq.jianying.com",
    cookies,
    schema: pluginServiceBrowserAuthorizationCompletionSchema,
  }
}

function serviceFor(
  state: MemoryAuthorizationState,
  metadata: XiaoYunqueServiceMetadataReader = connectedMetadata,
  now: () => number = () => fixedNow,
  authorizationTimeoutSeconds = 30,
) {
  return new XiaoYunquePluginService(state, metadata, {
    authorizationTimeoutSeconds,
    now,
    randomId: () => authorizationId,
  })
}

describe("XiaoYunque Plugin service", () => {
  test("treats the Cookie session as the sole configured state", async () => {
    let metadataReads = 0
    const service = serviceFor(new MemoryAuthorizationState(false), {
      read: async () => {
        metadataReads += 1
        return { consumed: 1, displayName: "must not publish", remaining: 1 }
      },
    })

    expect(await service.status()).toEqual({
      account: { availability: "unavailable" },
      credential: { configured: false, verification: "unverified" },
      credits: { availability: "unavailable" },
      schema: pluginServiceStatusSchema,
      state: "disconnected",
      usage: { availability: "unavailable" },
    })
    expect(metadataReads).toBe(0)
  })

  test("returns bounded live account status without exposing Cookie values", async () => {
    const service = serviceFor(new MemoryAuthorizationState(true))

    const status = await service.status()
    expect(status).toEqual({
      account: { availability: "available", displayName: "小云雀测试账号" },
      credential: { configured: true, verification: "verified" },
      credits: { availability: "available", remaining: 345, unit: "积分" },
      schema: pluginServiceStatusSchema,
      state: "connected",
      usage: {
        availability: "available",
        consumed: 12,
        period: "last up to 20 settled consumption records",
        unit: "积分",
      },
    })
    expect(JSON.stringify(status)).not.toContain(oldCookie)
    expect(JSON.stringify(status)).not.toContain("cookies")
  })

  test("keeps a verified balance visible when consumption history is unavailable", async () => {
    const service = serviceFor(new MemoryAuthorizationState(true), {
      read: async () => ({ consumed: null, displayName: "小云雀测试账号", remaining: 345 }),
    })

    expect(await service.status()).toEqual(expect.objectContaining({
      account: { availability: "available", displayName: "小云雀测试账号" },
      credential: { configured: true, verification: "verified" },
      credits: { availability: "available", remaining: 345, unit: "积分" },
      state: "connected",
      usage: { availability: "unavailable" },
    }))
  })

  test("requests reauthorization after Web session expiry without clearing the session", async () => {
    const state = new MemoryAuthorizationState(true)
    const service = serviceFor(state, {
      read: async () => { throw new XiaoYunqueServiceSessionExpiredError() },
    })

    expect(await service.status()).toEqual(expect.objectContaining({
      credential: { configured: true, verification: "failed" },
      state: "attention",
    }))
    expect(state.currentSession?.cookies[0]?.value).toBe(oldCookie)
    expect(state.clearEvents).toEqual([])
  })

  test("authorize returns the exact host browser request without mutating session state", async () => {
    const state = new MemoryAuthorizationState(false)
    const service = serviceFor(state)

    expect(await service.authorize()).toEqual({
      authorization_id: authorizationId,
      cookie_names: ["sessionid_pippitcn_web", "sessionid_ss_pippitcn_web"],
      cookie_origin: "https://xyq.jianying.com",
      login_url: "https://xyq.jianying.com/login?redirect_url=%2F",
      schema: pluginServiceBrowserAuthorizationSchema,
      timeout_seconds: 30,
    })
    expect(await state.snapshot()).toEqual({ configured: false, session: null })
    await expect(service.reauthorize()).rejects.toThrow("already in progress")
    service.close()
  })

  test("advertises a bounded 30-minute browser window", async () => {
    const state = new MemoryAuthorizationState(false)
    const service = new XiaoYunquePluginService(state, connectedMetadata, {
      now: () => fixedNow,
      randomId: () => authorizationId,
    })

    expect(await service.authorize()).toEqual(expect.objectContaining({
      authorization_id: authorizationId,
      timeout_seconds: 1_800,
    }))
    service.close()

    for (const invalidTimeout of [29, 1_800.5, 1_801]) {
      expect(() => new XiaoYunquePluginService(state, connectedMetadata, {
        authorizationTimeoutSeconds: invalidTimeout,
      })).toThrow("browser authorization timeout is invalid")
    }
  })

  test("completes only the current request and atomically publishes whitelisted Cookies", async () => {
    const state = new MemoryAuthorizationState(false)
    const service = serviceFor(state)
    await service.authorize()

    expect(await service.completeAuthorization(completion())).toEqual(expect.objectContaining({
      credential: { configured: true, verification: "verified" },
      credits: { availability: "available", remaining: 345, unit: "积分" },
      schema: pluginServiceStatusSchema,
      state: "connected",
    }))
    expect(state.currentSession).toEqual(expect.objectContaining({
      authorizedAt: fixedNow,
      cookies: [{ domain: "", name: "sessionid_pippitcn_web", path: "/", secure: true, value: newCookie }],
    }))
    expect(await service.status()).toEqual(expect.objectContaining({ state: "connected" }))
    await expect(service.completeAuthorization(completion())).rejects.toThrow("stale or invalid")
  })

  test("rejects wrong ids, origins, and non-whitelisted Cookies without changing the old session", async () => {
    for (const invalid of [
      completion("different_authorization_id"),
      { ...completion(), cookie_origin: "https://www.jianying.com" },
      completion(authorizationId, [{ name: "sessionid", value: "legacy-must-not-be-captured" }]),
      completion(authorizationId, [{ name: "passport_csrf_token", value: "must-not-store" }]),
    ]) {
      const state = new MemoryAuthorizationState(true)
      const oldRevision = state.currentSession?.revision
      const service = serviceFor(state)
      await service.reauthorize()

      await expect(service.completeAuthorization(invalid)).rejects.toThrow()
      expect(state.currentSession?.revision).toBe(oldRevision)
      expect(state.replaceCount).toBe(0)
      service.close()
    }
  })

  test("keeps the old session and same request retryable when reauthorization storage fails", async () => {
    const state = new MemoryAuthorizationState(true)
    const oldRevision = state.currentSession?.revision
    const service = serviceFor(state)
    await service.reauthorize()
    state.failNextReplace = true

    await expect(service.completeAuthorization(completion())).rejects.toThrow("private-store failure")
    expect(state.currentSession?.revision).toBe(oldRevision)

    await service.completeAuthorization(completion())
    expect(state.currentSession?.revision).not.toBe(oldRevision)
    expect(state.currentSession?.cookies[0]?.value).toBe(newCookie)
  })

  test("caller cancellation before completion preserves the old session and pending request", async () => {
    const state = new MemoryAuthorizationState(true)
    const oldRevision = state.currentSession?.revision
    const service = serviceFor(state)
    await service.reauthorize()
    const controller = new AbortController()
    controller.abort("private-cancel-reason")

    await expect(service.completeAuthorization(completion(), controller.signal))
      .rejects.toMatchObject({ name: "AbortError" })
    expect(state.currentSession?.revision).toBe(oldRevision)
    await service.completeAuthorization(completion())
    expect(state.currentSession?.revision).not.toBe(oldRevision)
  })

  test("never publishes metadata read with a session replaced during the request", async () => {
    const state = new MemoryAuthorizationState(true)
    let started!: () => void
    const didStart = new Promise<void>((resolve) => { started = resolve })
    let release!: () => void
    const mayFinish = new Promise<void>((resolve) => { release = resolve })
    let metadataReads = 0
    const service = serviceFor(state, {
      read: async () => {
        metadataReads += 1
        if (metadataReads > 1) return connectedMetadata.read(storedSession(newCookie, 2))
        started()
        await mayFinish
        return { consumed: 999, displayName: "stale-account", remaining: 999 }
      },
    })
    const inspecting = service.status()
    await didStart
    await service.reauthorize()
    await service.completeAuthorization(completion())
    release()

    expect(await inspecting).toEqual(expect.objectContaining({
      account: { availability: "unavailable" },
      credential: { configured: true, verification: "unverified" },
      state: "unknown",
    }))
  })

  test("retains only a 30-second completion-handoff grace after the host deadline", async () => {
    let now = fixedNow
    const withinGraceState = new MemoryAuthorizationState(false)
    const withinGrace = new XiaoYunquePluginService(withinGraceState, connectedMetadata, {
      now: () => now,
      randomId: () => authorizationId,
    })
    await withinGrace.authorize()
    now += 1_829_999

    await withinGrace.completeAuthorization(completion())
    expect(withinGraceState.currentSession?.cookies[0]?.value).toBe(newCookie)

    now = fixedNow
    const expiredState = new MemoryAuthorizationState(true)
    const oldRevision = expiredState.currentSession?.revision
    const expired = new XiaoYunquePluginService(expiredState, connectedMetadata, {
      now: () => now,
      randomId: () => authorizationId,
    })
    await expired.reauthorize()
    now += 1_830_000

    await expect(expired.completeAuthorization(completion())).rejects.toThrow("stale or invalid")
    expect(expiredState.currentSession?.revision).toBe(oldRevision)
    expired.close()
  })

  test("cancel and post-grace timeout reject stale completions while preserving an old session", async () => {
    let now = fixedNow
    for (const mode of ["cancel", "timeout"] as const) {
      const state = new MemoryAuthorizationState(true)
      const oldRevision = state.currentSession?.revision
      const service = serviceFor(state, connectedMetadata, () => now)
      await service.reauthorize()
      if (mode === "cancel") {
        expect(await service.cancelAuthorization()).toEqual(expect.objectContaining({ state: "unknown" }))
      } else {
        now += 60_000
      }

      await expect(service.completeAuthorization(completion())).rejects.toThrow("stale or invalid")
      expect(state.currentSession?.revision).toBe(oldRevision)
      service.close()
    }
  })

  test("sign-out cancels status work, expires authorization, and clears the Cookie store", async () => {
    const state = new MemoryAuthorizationState(true)
    let started!: () => void
    const didStart = new Promise<void>((resolve) => { started = resolve })
    const service = serviceFor(state, {
      read: async (_session, signal) => {
        started()
        await new Promise<void>((_resolve, reject) => {
          const onAbort = () => reject(new DOMException("cancelled", "AbortError"))
          signal?.addEventListener("abort", onAbort, { once: true })
          if (signal?.aborted) onAbort()
        })
        throw new Error("unreachable")
      },
    })
    await service.reauthorize()
    const inspecting = service.status()
    void inspecting.catch(() => undefined)
    await didStart

    expect(await service.signOut()).toEqual(expect.objectContaining({ state: "disconnected" }))
    await expect(inspecting).rejects.toMatchObject({ name: "AbortError" })
    expect(state.currentSession).toBeNull()
    expect(state.clearEvents).toEqual(["clear"])
    await expect(service.completeAuthorization(completion())).rejects.toThrow("stale or invalid")
  })

  test("close expires only the in-memory request and preserves the committed session", async () => {
    const state = new MemoryAuthorizationState(true)
    const oldRevision = state.currentSession?.revision
    const service = serviceFor(state)
    await service.reauthorize()

    service.close()

    await expect(service.completeAuthorization(completion())).rejects.toThrow("stale or invalid")
    expect(state.currentSession?.revision).toBe(oldRevision)
  })
})
