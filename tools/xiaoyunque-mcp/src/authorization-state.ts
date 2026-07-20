import { randomUUID } from "node:crypto"
import { XiaoYunqueCredentialConfigurationError } from "./configuration-error.ts"
import {
  type StoredWebSession,
  type WebSessionCookie,
  type WebSessionStore,
  webSessionIsUsable,
  webSessionSchema,
} from "./web-session-store.ts"

export interface BrowserSessionAuthorizationResult {
  authorizedAt: number
  cookies: WebSessionCookie[]
}

export interface AuthorizationSnapshot {
  configured: boolean
  session: StoredWebSession | null
}

export interface WebSessionAuthorizer {
  session(signal?: AbortSignal): Promise<StoredWebSession>
}

export interface AuthorizationStateController extends WebSessionAuthorizer {
  clear(): Promise<void>
  isCurrent(snapshot: AuthorizationSnapshot): Promise<boolean>
  replace(result: BrowserSessionAuthorizationResult): Promise<void>
  snapshot(): Promise<AuthorizationSnapshot>
}

function abortError(reason?: unknown) {
  return new DOMException(
    reason instanceof Error ? reason.message : "XiaoYunque authorization was cancelled",
    "AbortError",
  )
}

function waitWithSignal<T>(operation: Promise<T>, signal?: AbortSignal) {
  if (!signal) return operation
  if (signal.aborted) return Promise.reject(abortError(signal.reason))
  return new Promise<T>((resolve, reject) => {
    let settled = false
    const finish = (complete: () => void) => {
      if (settled) return
      settled = true
      signal.removeEventListener("abort", onAbort)
      complete()
    }
    const onAbort = () => finish(() => reject(abortError(signal.reason)))
    signal.addEventListener("abort", onAbort, { once: true })
    if (signal.aborted) onAbort()
    operation.then(
      (value) => finish(() => resolve(value)),
      (error: unknown) => finish(() => reject(error)),
    )
  })
}

function storedSessionFor(result: BrowserSessionAuthorizationResult): StoredWebSession {
  return {
    authorizedAt: result.authorizedAt,
    cookies: result.cookies,
    revision: randomUUID(),
    schema: webSessionSchema,
  }
}

/** Owns the single authoritative XiaoYunque browser Cookie session. */
export class XiaoYunqueAuthorizationState implements AuthorizationStateController {
  #mutationTail: Promise<void> = Promise.resolve()

  constructor(private readonly sessions: WebSessionStore) {}

  async snapshot(): Promise<AuthorizationSnapshot> {
    await this.#mutationTail
    let session: StoredWebSession | null
    try {
      session = await this.sessions.read()
    } catch {
      // Corrupt, tampered, legacy, and unreadable state all fail closed. A
      // later explicit authorization can replace the private file atomically.
      session = null
    }
    if (!session || !webSessionIsUsable(session)) {
      return { configured: false, session: null }
    }
    return { configured: true, session }
  }

  async session(signal?: AbortSignal) {
    if (signal?.aborted) throw abortError(signal.reason)
    const snapshot = await waitWithSignal(this.snapshot(), signal)
    if (signal?.aborted) throw abortError(signal.reason)
    if (!snapshot.session) {
      throw new XiaoYunqueCredentialConfigurationError()
    }
    return snapshot.session
  }

  async isCurrent(snapshot: AuthorizationSnapshot) {
    const current = await this.snapshot()
    return current.configured === snapshot.configured
      && current.session?.revision === snapshot.session?.revision
  }

  async replace(result: BrowserSessionAuthorizationResult) {
    await this.#mutate(async () => {
      // FileWebSessionStore publishes through one private atomic rename. It
      // never clears the previous session first, so a failed reauthorization
      // leaves the last complete session authoritative.
      await this.sessions.write(storedSessionFor(result))
    })
  }

  async clear() {
    await this.#mutate(() => this.sessions.clear())
  }

  async #mutate<T>(operation: () => Promise<T>) {
    const preceding = this.#mutationTail
    let release!: () => void
    this.#mutationTail = new Promise<void>((resolve) => { release = resolve })
    await preceding
    try {
      return await operation()
    } finally {
      release()
    }
  }
}
