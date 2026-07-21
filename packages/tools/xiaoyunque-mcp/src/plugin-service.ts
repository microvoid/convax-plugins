import { randomUUID } from "node:crypto"
import type {
  AuthorizationSnapshot,
  AuthorizationStateController,
} from "./authorization-state.ts"
import {
  pluginServiceBrowserAuthorizationSchema,
  pluginServiceStatusSchema,
  type PluginServiceBrowserAuthorizationCompletion,
  type PluginServiceBrowserAuthorizationRequest,
  type PluginServiceStatus,
} from "./contracts.ts"
import {
  XiaoYunqueServiceSessionExpiredError,
  type XiaoYunqueServiceMetadata,
  type XiaoYunqueServiceMetadataReader,
} from "./service-metadata.ts"
import {
  xiaoYunqueCookieOrigin,
  xiaoYunqueSessionCookieNames,
} from "./web-session-store.ts"

const unavailable = { availability: "unavailable" } as const
const usagePeriod = "last up to 20 settled consumption records"
const loginUrl = new URL("/login", xiaoYunqueCookieOrigin)
loginUrl.searchParams.set("redirect_url", "/")
const browserAuthorizationLoginUrl = loginUrl.toString()
const minimumAuthorizationTimeoutSeconds = 30
const maximumAuthorizationTimeoutSeconds = 1_800
const defaultAuthorizationTimeoutSeconds = maximumAuthorizationTimeoutSeconds
const authorizationCompletionHandoffGraceSeconds = 30
const allowedCookieNames: ReadonlySet<string> = new Set(xiaoYunqueSessionCookieNames)

function statusFor(snapshot: Pick<AuthorizationSnapshot, "configured">): PluginServiceStatus {
  return {
    account: unavailable,
    credential: {
      configured: snapshot.configured,
      verification: "unverified",
    },
    credits: unavailable,
    schema: pluginServiceStatusSchema,
    state: snapshot.configured ? "unknown" : "disconnected",
    usage: unavailable,
  }
}

function attentionStatus(): PluginServiceStatus {
  return {
    account: unavailable,
    credential: { configured: true, verification: "failed" },
    credits: unavailable,
    schema: pluginServiceStatusSchema,
    state: "attention",
    usage: unavailable,
  }
}

function connectedStatus(metadata: XiaoYunqueServiceMetadata): PluginServiceStatus {
  return {
    account: metadata.displayName === null
      ? unavailable
      : { availability: "available", displayName: metadata.displayName },
    credential: { configured: true, verification: "verified" },
    credits: metadata.remaining === null
      ? unavailable
      : { availability: "available", remaining: metadata.remaining, unit: "积分" },
    schema: pluginServiceStatusSchema,
    state: "connected",
    usage: metadata.consumed === null
      ? unavailable
      : {
          availability: "available",
          consumed: metadata.consumed,
          period: usagePeriod,
          unit: "积分",
        },
  }
}

function isAbortError(error: unknown) {
  return error instanceof DOMException && error.name === "AbortError"
}

function serviceAbortError(reason?: unknown) {
  return new DOMException(
    reason instanceof Error ? reason.message : "XiaoYunque service action was cancelled",
    "AbortError",
  )
}

function waitForControlAction(operation: Promise<void>, signal?: AbortSignal) {
  if (signal?.aborted) throw serviceAbortError(signal.reason)
  if (!signal) return operation
  return new Promise<void>((resolve, reject) => {
    let settled = false
    const finish = (complete: () => void) => {
      if (settled) return
      settled = true
      signal.removeEventListener("abort", onAbort)
      complete()
    }
    const onAbort = () => finish(() => reject(serviceAbortError(signal.reason)))
    signal.addEventListener("abort", onAbort, { once: true })
    if (signal.aborted) onAbort()
    operation.then(
      () => finish(resolve),
      (error: unknown) => finish(() => reject(error)),
    )
  })
}

interface ActiveStatus {
  controller: AbortController
  operation: Promise<PluginServiceStatus>
}

interface PendingAuthorization {
  expiresAt: number
  id: string
  timer: ReturnType<typeof setTimeout>
}

interface XiaoYunquePluginServiceOptions {
  authorizationTimeoutSeconds?: number
  now?: () => number
  randomId?: () => string
}

export class XiaoYunquePluginService {
  readonly #activeStatuses = new Set<ActiveStatus>()
  readonly #authorizationTimeoutSeconds: number
  #controlActionTail: Promise<void> = Promise.resolve()
  readonly #now: () => number
  #pendingAuthorization: PendingAuthorization | null = null
  #pendingControlActions = 0
  readonly #randomId: () => string

  constructor(
    private readonly authorizationState: AuthorizationStateController,
    private readonly metadata: XiaoYunqueServiceMetadataReader,
    options: XiaoYunquePluginServiceOptions = {},
  ) {
    this.#authorizationTimeoutSeconds = options.authorizationTimeoutSeconds
      ?? defaultAuthorizationTimeoutSeconds
    if (
      !Number.isSafeInteger(this.#authorizationTimeoutSeconds)
      || this.#authorizationTimeoutSeconds < minimumAuthorizationTimeoutSeconds
      || this.#authorizationTimeoutSeconds > maximumAuthorizationTimeoutSeconds
    ) {
      throw new Error("XiaoYunque browser authorization timeout is invalid")
    }
    this.#now = options.now ?? Date.now
    this.#randomId = options.randomId ?? randomUUID
  }

  async status(signal?: AbortSignal) {
    if (signal?.aborted) throw serviceAbortError(signal.reason)
    while (this.#pendingControlActions > 0) {
      await waitForControlAction(this.#controlActionTail, signal)
    }
    return this.#inspectStatus(signal)
  }

  async #readStatus(signal: AbortSignal) {
    if (signal.aborted) throw serviceAbortError(signal.reason)
    const snapshot = await this.authorizationState.snapshot()
    if (signal.aborted) throw serviceAbortError(signal.reason)
    if (!snapshot.session) return statusFor(snapshot)
    let serviceMetadata: XiaoYunqueServiceMetadata
    try {
      serviceMetadata = await this.metadata.read(snapshot.session, signal)
    } catch (error) {
      if (signal.aborted) throw serviceAbortError(signal.reason)
      if (isAbortError(error)) throw error
      if (!await this.authorizationState.isCurrent(snapshot)) {
        return statusFor(await this.authorizationState.snapshot())
      }
      return error instanceof XiaoYunqueServiceSessionExpiredError
        ? attentionStatus()
        : statusFor(snapshot)
    }
    if (signal.aborted) throw serviceAbortError(signal.reason)
    if (!await this.authorizationState.isCurrent(snapshot)) {
      // Never publish account data read with a session that was replaced or
      // signed out while metadata requests were in flight.
      return statusFor(await this.authorizationState.snapshot())
    }
    return connectedStatus(serviceMetadata)
  }

  async #inspectStatus(signal?: AbortSignal) {
    if (signal?.aborted) throw serviceAbortError(signal.reason)
    const controller = new AbortController()
    const onAbort = () => controller.abort("Caller cancelled service status")
    signal?.addEventListener("abort", onAbort, { once: true })
    if (signal?.aborted) onAbort()
    const operation = this.#readStatus(controller.signal)
    const active = { controller, operation }
    this.#activeStatuses.add(active)
    try {
      return await operation
    } finally {
      signal?.removeEventListener("abort", onAbort)
      this.#activeStatuses.delete(active)
    }
  }

  async authorize(signal?: AbortSignal) {
    return this.#beginAuthorization(signal)
  }

  async reauthorize(signal?: AbortSignal) {
    return this.#beginAuthorization(signal)
  }

  async completeAuthorization(
    completion: PluginServiceBrowserAuthorizationCompletion,
    signal?: AbortSignal,
  ) {
    return this.#runControlAction(async () => {
      if (signal?.aborted) throw serviceAbortError(signal.reason)
      const pending = this.#requireCurrentAuthorization(completion)
      const cookies = completion.cookies.map(({ name, value }) => {
        if (!allowedCookieNames.has(name)) {
          throw new Error("XiaoYunque browser authorization returned an unsupported Cookie")
        }
        return { domain: "", name, path: "/", secure: true, value }
      })
      await this.authorizationState.replace({
        authorizedAt: this.#now(),
        cookies,
      })
      // Once the private atomic write begins, caller cancellation cannot turn
      // a complete new session into a partial commit. Clear the request only
      // after publication succeeds; a failed write remains retryable until its
      // bounded completion-handoff deadline and leaves the previous session
      // untouched.
      this.#clearPendingAuthorization(pending)
      // Return live account and credit metadata in the authorization result so
      // the Services UI does not remain at unknown/unavailable until refresh.
      // This intentionally uses an internal bounded inspection after the
      // atomic commit; caller cancellation cannot roll back a published session.
      return this.#inspectStatus()
    })
  }

  async cancelAuthorization(signal?: AbortSignal) {
    return this.#runControlAction(async () => {
      if (signal?.aborted) throw serviceAbortError(signal.reason)
      this.#clearPendingAuthorization()
      return statusFor(await this.authorizationState.snapshot())
    })
  }

  async signOut(signal?: AbortSignal) {
    return this.#runControlAction(async () => {
      if (signal?.aborted) throw serviceAbortError(signal.reason)
      this.#clearPendingAuthorization()
      const statuses = [...this.#activeStatuses]
      for (const status of statuses) {
        status.controller.abort("Local sign-out cancelled service status")
      }
      await Promise.all(statuses.map(({ operation }) => operation.catch(() => undefined)))
      await this.authorizationState.clear()
      return statusFor({ configured: false })
    })
  }

  close() {
    this.#clearPendingAuthorization()
    for (const status of this.#activeStatuses) {
      status.controller.abort("XiaoYunque sidecar is closing")
    }
  }

  async #beginAuthorization(signal?: AbortSignal): Promise<PluginServiceBrowserAuthorizationRequest> {
    return this.#runControlAction(async () => {
      if (signal?.aborted) throw serviceAbortError(signal.reason)
      this.#expirePendingAuthorization()
      if (this.#pendingAuthorization) {
        throw new Error("A XiaoYunque browser authorization is already in progress")
      }
      const id = this.#randomId()
      if (!/^[A-Za-z0-9_-]{16,128}$/u.test(id)) {
        throw new Error("Unable to create XiaoYunque browser authorization")
      }
      // The host owns the advertised browser deadline. Retain the exact pending
      // id briefly afterward so a completion captured before that deadline does
      // not lose a race with the sidecar timer or MCP transport.
      const pendingLifetimeMilliseconds = (
        this.#authorizationTimeoutSeconds + authorizationCompletionHandoffGraceSeconds
      ) * 1_000
      const expiresAt = this.#now() + pendingLifetimeMilliseconds
      const timer = setTimeout(() => {
        const pending = this.#pendingAuthorization
        if (pending?.id === id) this.#clearPendingAuthorization(pending)
      }, pendingLifetimeMilliseconds)
      timer.unref?.()
      this.#pendingAuthorization = { expiresAt, id, timer }
      return {
        authorization_id: id,
        cookie_names: [...xiaoYunqueSessionCookieNames],
        cookie_origin: xiaoYunqueCookieOrigin,
        login_url: browserAuthorizationLoginUrl,
        schema: pluginServiceBrowserAuthorizationSchema,
        timeout_seconds: this.#authorizationTimeoutSeconds,
      }
    })
  }

  #requireCurrentAuthorization(completion: PluginServiceBrowserAuthorizationCompletion) {
    this.#expirePendingAuthorization()
    const pending = this.#pendingAuthorization
    if (
      !pending
      || completion.authorization_id !== pending.id
      || completion.cookie_origin !== xiaoYunqueCookieOrigin
    ) {
      throw new Error("XiaoYunque browser authorization is stale or invalid")
    }
    return pending
  }

  #expirePendingAuthorization() {
    const pending = this.#pendingAuthorization
    if (pending && this.#now() >= pending.expiresAt) {
      this.#clearPendingAuthorization(pending)
    }
  }

  #clearPendingAuthorization(expected?: PendingAuthorization) {
    const pending = this.#pendingAuthorization
    if (!pending || expected && pending !== expected) return
    this.#pendingAuthorization = null
    clearTimeout(pending.timer)
  }

  async #runControlAction<T>(action: () => Promise<T>) {
    this.#pendingControlActions += 1
    const preceding = this.#controlActionTail
    let release!: () => void
    this.#controlActionTail = new Promise<void>((resolve) => { release = resolve })
    await preceding
    try {
      return await action()
    } finally {
      this.#pendingControlActions -= 1
      release()
    }
  }
}
