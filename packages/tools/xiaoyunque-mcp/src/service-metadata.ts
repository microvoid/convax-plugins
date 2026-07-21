import { createHash } from "node:crypto"
import { type StoredWebSession, webSessionCookieHeader } from "./web-session-store.ts"

const officialOrigin = "https://xyq.jianying.com"
const accountPath = "/api/biz/v1/user/info"
const creditPath = "/commerce/v1/benefits/user_credit"
const historyPath = "/commerce/v1/benefits/user_credit_history"
const maximumResponseBytes = 256 * 1024
const maximumMetric = 1e15
const defaultTimeoutMs = 10_000

export const xiaoYunqueServiceEndpoints = {
  account: `${officialOrigin}${accountPath}`,
  credits: `${officialOrigin}${creditPath}`,
  history: `${officialOrigin}${historyPath}`,
} as const

export interface XiaoYunqueServiceMetadata {
  consumed: number | null
  displayName: string | null
  remaining: number | null
}

export interface XiaoYunqueServiceMetadataReader {
  read(session: StoredWebSession, signal?: AbortSignal): Promise<XiaoYunqueServiceMetadata>
}

export class XiaoYunqueServiceSessionExpiredError extends Error {
  override readonly name = "XiaoYunqueServiceSessionExpiredError"

  constructor() {
    super("XiaoYunque Web authorization requires attention")
  }
}

class XiaoYunqueServiceMetadataError extends Error {
  override readonly name = "XiaoYunqueServiceMetadataError"

  constructor() {
    super("Unable to inspect XiaoYunque service metadata")
  }
}

interface ServiceMetadataOptions {
  baseUrl?: string
  fetchImpl?: typeof fetch
  now?: () => number
  timeoutMs?: number
}

function abortError() {
  return new DOMException("XiaoYunque service inspection was cancelled", "AbortError")
}

function strictRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new XiaoYunqueServiceMetadataError()
  }
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) {
    throw new XiaoYunqueServiceMetadataError()
  }
  return value as Record<string, unknown>
}

function strictRetZero(payload: Record<string, unknown>) {
  return payload.ret === 0 || payload.ret === "0"
}

function parseBoundedInteger(value: unknown, allowNegative = false) {
  let parsed: bigint
  try {
    if (typeof value === "number") {
      if (!Number.isSafeInteger(value)) throw new XiaoYunqueServiceMetadataError()
      parsed = BigInt(value)
    } else if (typeof value === "string" && /^-?(?:0|[1-9][0-9]*)$/u.test(value)) {
      parsed = BigInt(value)
    } else {
      throw new XiaoYunqueServiceMetadataError()
    }
  } catch (error) {
    if (error instanceof XiaoYunqueServiceMetadataError) throw error
    throw new XiaoYunqueServiceMetadataError()
  }
  const maximum = BigInt(maximumMetric)
  if ((!allowNegative && parsed < 0n) || parsed > maximum || parsed < -maximum) {
    throw new XiaoYunqueServiceMetadataError()
  }
  return Number(parsed)
}

function optionalNonNegativeInteger(value: unknown) {
  return value === undefined || value === null ? 0 : parseBoundedInteger(value)
}

function accountName(payload: Record<string, unknown>) {
  const data = strictRecord(payload.data)
  if (data.name === undefined || data.name === null || data.name === "") return null
  if (
    typeof data.name !== "string"
    || data.name !== data.name.trim()
    || data.name.length > 120
    || /[\u0000-\u001f\u007f]/u.test(data.name)
    || /[a-z][a-z0-9+.-]*:\/\//iu.test(data.name)
    || /(?:^|\s)(?:file:|mailto:|data:|\.{1,2}[\\/]|\/{1,2}(?:[^\s]|$)|[A-Za-z]:[\\/]|\\\\)/iu.test(data.name)
    || /\b(?:bearer|cookie|token|access[ _-]?key|secret[ _-]?key|ak|sk)\b\s*[:=]?\s*\S{8,}/iu.test(data.name)
    || /\b[A-Za-z0-9_-]{48,}\b/u.test(data.name)
  ) {
    return null
  }
  return data.name
}

function remainingCredits(payload: Record<string, unknown>) {
  const data = strictRecord(payload.data)
  const credit = strictRecord(data.credit)
  const keys = ["vip_credit", "gift_credit", "purchase_credit", "free_credits"] as const
  if (!keys.some((key) => credit[key] !== undefined && credit[key] !== null)) {
    throw new XiaoYunqueServiceMetadataError()
  }
  let remaining = 0
  for (const key of keys) {
    remaining += optionalNonNegativeInteger(credit[key])
    if (!Number.isSafeInteger(remaining) || remaining > maximumMetric) {
      throw new XiaoYunqueServiceMetadataError()
    }
  }
  return remaining
}

function settledConsumption(payload: Record<string, unknown>) {
  const data = strictRecord(payload.data)
  const records = data.records
  if (!Array.isArray(records) || records.length > 20) {
    throw new XiaoYunqueServiceMetadataError()
  }
  let consumed = 0
  for (const raw of records) {
    const record = strictRecord(raw)
    if (record.history_type !== 2 && record.history_type !== "2") {
      throw new XiaoYunqueServiceMetadataError()
    }
    if (
      record.status !== "Init"
      && record.status !== "Checked"
      && record.status !== "CheckFailed"
      && record.status !== "Canceled"
    ) {
      throw new XiaoYunqueServiceMetadataError()
    }
    if (record.status !== "Checked") continue
    const amount = Math.abs(parseBoundedInteger(record.amount, true))
    consumed += amount
    if (!Number.isSafeInteger(consumed) || consumed > maximumMetric) {
      throw new XiaoYunqueServiceMetadataError()
    }
  }
  return consumed
}

function signHeaders(pathname: string, nowMilliseconds: number) {
  const deviceTime = Math.floor(nowMilliseconds / 1_000)
  if (!Number.isSafeInteger(deviceTime) || deviceTime <= 0) {
    throw new XiaoYunqueServiceMetadataError()
  }
  const sign = createHash("md5")
    .update(`9e2c|${pathname.slice(-7)}|7|5.8.0|${deviceTime}||11ac`, "utf8")
    .digest("hex")
    .toLowerCase()
  return {
    appvr: "5.8.0",
    "device-time": String(deviceTime),
    pf: "7",
    sign,
    "sign-ver": "1",
  } as const
}

async function readBoundedJson(
  response: Response,
  race: <T>(operation: Promise<T>) => Promise<T>,
) {
  const reader = response.body?.getReader()
  if (!reader) throw new XiaoYunqueServiceMetadataError()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    while (true) {
      const { done, value } = await race(reader.read())
      if (done) break
      size += value.byteLength
      if (size > maximumResponseBytes) {
        await reader.cancel().catch(() => undefined)
        throw new XiaoYunqueServiceMetadataError()
      }
      chunks.push(value)
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined)
    throw error
  } finally {
    reader.releaseLock()
  }
  const bytes = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes)
    return strictRecord(JSON.parse(text) as unknown)
  } catch (error) {
    if (error instanceof XiaoYunqueServiceMetadataError) throw error
    throw new XiaoYunqueServiceMetadataError()
  }
}

function requestDeadline(timeoutMs: number, callerSignal?: AbortSignal) {
  const controller = new AbortController()
  let rejectTermination!: (error: unknown) => void
  const termination = new Promise<never>((_resolve, reject) => { rejectTermination = reject })
  void termination.catch(() => undefined)
  let settled = false
  let reason: "caller" | "timeout" | null = null
  const terminate = (kind: "caller" | "timeout", error: unknown) => {
    if (settled) return
    settled = true
    reason = kind
    controller.abort(error)
    rejectTermination(error)
  }
  const onAbort = () => terminate("caller", abortError())
  callerSignal?.addEventListener("abort", onAbort, { once: true })
  const timer = setTimeout(
    () => terminate("timeout", new XiaoYunqueServiceMetadataError()),
    timeoutMs,
  )
  if (callerSignal?.aborted) onAbort()
  return {
    finish() {
      settled = true
      clearTimeout(timer)
      callerSignal?.removeEventListener("abort", onAbort)
    },
    race<T>(operation: Promise<T>) {
      return Promise.race([operation, termination])
    },
    reason() {
      return reason
    },
    signal: controller.signal,
  }
}

export class XiaoYunqueServiceMetadataClient implements XiaoYunqueServiceMetadataReader {
  readonly #baseUrl: URL
  readonly #fetch: typeof fetch
  readonly #now: () => number
  readonly #timeoutMs: number

  constructor(options: ServiceMetadataOptions = {}) {
    this.#baseUrl = new URL(options.baseUrl ?? officialOrigin)
    const hasExactBaseShape =
      !this.#baseUrl.username
      && !this.#baseUrl.password
      && !this.#baseUrl.search
      && !this.#baseUrl.hash
      && this.#baseUrl.pathname === "/"
    const isOfficial =
      hasExactBaseShape
      && this.#baseUrl.protocol === "https:"
      && this.#baseUrl.hostname === "xyq.jianying.com"
      && !this.#baseUrl.port
    const isLoopbackTest =
      hasExactBaseShape
      && this.#baseUrl.protocol === "http:"
      && this.#baseUrl.hostname === "127.0.0.1"
    if (!isOfficial && !isLoopbackTest) {
      throw new Error("XiaoYunque service metadata origin is invalid")
    }
    this.#fetch = options.fetchImpl ?? fetch
    this.#now = options.now ?? Date.now
    this.#timeoutMs = options.timeoutMs ?? defaultTimeoutMs
    if (!Number.isSafeInteger(this.#timeoutMs) || this.#timeoutMs < 10 || this.#timeoutMs > 60_000) {
      throw new Error("XiaoYunque service metadata timeout is invalid")
    }
  }

  async read(session: StoredWebSession, signal?: AbortSignal) {
    let consumed: number | null = null
    let displayName: string | null = null
    let remaining: number | null = null
    let verifiedResponses = 0
    try {
      const account = await this.#request(session, accountPath, "GET", undefined, false, signal)
      verifiedResponses += 1
      displayName = accountName(account)
    } catch (error) {
      if (error instanceof XiaoYunqueServiceSessionExpiredError || signal?.aborted) throw error
      if (error instanceof DOMException && error.name === "AbortError") throw error
      // Account name is optional display metadata. A transient failure here
      // must not suppress independently verified credit/usage metrics.
    }
    try {
      const credits = await this.#request(session, creditPath, "POST", {}, true, signal)
      verifiedResponses += 1
      remaining = remainingCredits(credits)
    } catch (error) {
      if (error instanceof XiaoYunqueServiceSessionExpiredError || signal?.aborted) throw error
      if (error instanceof DOMException && error.name === "AbortError") throw error
      // Keep an independently verified account and usage result visible when
      // the balance surface is transiently unavailable or changes shape.
    }
    try {
      const history = await this.#request(session, historyPath, "POST", {
        count: 20,
        history_type: 2,
        need_with_hold: false,
      }, true, signal)
      verifiedResponses += 1
      consumed = settledConsumption(history)
    } catch (error) {
      if (error instanceof XiaoYunqueServiceSessionExpiredError || signal?.aborted) throw error
      if (error instanceof DOMException && error.name === "AbortError") throw error
      // Consumption history is optional service metadata. Its failure must not
      // hide a valid current balance returned by the independent endpoint.
    }
    if (verifiedResponses === 0) throw new XiaoYunqueServiceMetadataError()
    return { consumed, displayName, remaining }
  }

  async #request(
    session: StoredWebSession,
    pathname: string,
    method: "GET" | "POST",
    body: Record<string, unknown> | undefined,
    signed: boolean,
    signal?: AbortSignal,
  ) {
    if (signal?.aborted) throw abortError()
    const url = new URL(pathname, this.#baseUrl)
    // The loopback origin exists only for local black-box tests. Cookie scope
    // remains bound to the exact production HTTPS origin in every mode.
    const cookieUrl = this.#baseUrl.origin === officialOrigin
      ? url
      : new URL(pathname, officialOrigin)
    const cookie = webSessionCookieHeader(session.cookies, cookieUrl, this.#now())
    if (!cookie) throw new XiaoYunqueServiceSessionExpiredError()
    const deadline = requestDeadline(this.#timeoutMs, signal)
    try {
      const headers: Record<string, string> = {
        Accept: "application/json",
        appid: "795647",
        appvr: signed ? "5.8.0" : "1.1.4",
        Cookie: cookie,
        "entrance-from": "web",
        pf: "7",
        ...(signed
          ? {
              "Content-Type": "application/json",
              loc: "CN",
              ...signHeaders(pathname, this.#now()),
            }
          : {}),
      }
      let response: Response
      try {
        response = await deadline.race(this.#fetch(url, {
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          headers,
          method,
          redirect: "error",
          signal: deadline.signal,
        }))
      } catch (error) {
        if (signal?.aborted || deadline.reason() === "caller") {
          throw abortError()
        }
        if (deadline.reason() === "timeout") throw new XiaoYunqueServiceMetadataError()
        if (error instanceof XiaoYunqueServiceMetadataError) throw error
        throw new XiaoYunqueServiceMetadataError()
      }
      if (response.status === 401) {
        await response.body?.cancel().catch(() => undefined)
        throw new XiaoYunqueServiceSessionExpiredError()
      }
      const payload = await readBoundedJson(response, deadline.race)
      if (Number(payload.ret) === 1015) throw new XiaoYunqueServiceSessionExpiredError()
      if (!response.ok || !strictRetZero(payload)) throw new XiaoYunqueServiceMetadataError()
      return payload
    } finally {
      deadline.finish()
    }
  }
}
