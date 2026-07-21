import {
  chmod,
  lstat,
  mkdir,
  open,
  rename,
  rm,
} from "node:fs/promises"
import path from "node:path"
import { exclusiveNoFollowWriteFlags, noFollowReadFlags } from "./private-file.ts"

export const webSessionSchema = "convax.xiaoyunque-web-session/2" as const
export const xiaoYunqueCookieOrigin = "https://xyq.jianying.com" as const
export const xiaoYunqueSessionCookieNames = [
  "sessionid_pippitcn_web",
  "sessionid_ss_pippitcn_web",
] as const

const maximumSessionFileBytes = 64 * 1024
const maximumCookieValueBytes = 16 * 1024
const maximumCookieBytes = 32 * 1024
const maximumSessionCookies = 2
// Builds before the direct Web authorization fix could persist the unsuffixed
// names used by the first-party CLI grant exchange. Keep those files readable so
// an upgrade does not throw away a still-valid session, but never request or
// accept these legacy names from the direct browser completion path.
const legacyStoredCookieNames = ["sessionid", "sessionid_ss"] as const
const allowedStoredCookieNames: ReadonlySet<string> = new Set([
  ...xiaoYunqueSessionCookieNames,
  ...legacyStoredCookieNames,
])

export interface WebSessionCookie {
  domain: string
  expiresAt?: number
  name: string
  path: string
  secure: boolean
  value: string
}

export interface StoredWebSession {
  authorizedAt: number
  cookies: WebSessionCookie[]
  revision: string
  schema: typeof webSessionSchema
}

export interface WebSessionStore {
  clear(): Promise<void>
  read(): Promise<StoredWebSession | null>
  write(session: StoredWebSession): Promise<void>
}

function sessionStoreError() {
  return new Error("Unable to access the local XiaoYunque Web session")
}

function strictRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw sessionStoreError()
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) throw sessionStoreError()
  return value as Record<string, unknown>
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]) {
  const expected = new Set(keys)
  if (Object.keys(value).length !== keys.length || Object.keys(value).some((key) => !expected.has(key))) {
    throw sessionStoreError()
  }
}

function parseCookie(value: unknown): WebSessionCookie {
  const cookie = strictRecord(value)
  const allowedKeys = cookie.expiresAt === undefined
    ? ["domain", "name", "path", "secure", "value"]
    : ["domain", "expiresAt", "name", "path", "secure", "value"]
  exactKeys(cookie, allowedKeys)
  if (
    typeof cookie.name !== "string"
    || !allowedStoredCookieNames.has(cookie.name)
    || typeof cookie.value !== "string"
    || cookie.value.length === 0
    || Buffer.byteLength(cookie.value, "utf8") > maximumCookieValueBytes
    || /[\u0000-\u0020\u007f;]/u.test(cookie.value)
    || cookie.domain !== ""
    || cookie.path !== "/"
    || cookie.secure !== true
    || (cookie.expiresAt !== undefined
      && (!Number.isSafeInteger(cookie.expiresAt) || Number(cookie.expiresAt) <= 0))
  ) {
    throw sessionStoreError()
  }
  return {
    domain: cookie.domain.toLowerCase(),
    ...(cookie.expiresAt === undefined ? {} : { expiresAt: Number(cookie.expiresAt) }),
    name: cookie.name,
    path: cookie.path,
    secure: cookie.secure,
    value: cookie.value,
  }
}

export function parseStoredWebSession(value: unknown): StoredWebSession {
  const session = strictRecord(value)
  exactKeys(session, ["authorizedAt", "cookies", "revision", "schema"])
  if (
    session.schema !== webSessionSchema
    || !Number.isSafeInteger(session.authorizedAt)
    || Number(session.authorizedAt) <= 0
    || typeof session.revision !== "string"
    || !/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(session.revision)
    || !Array.isArray(session.cookies)
    || session.cookies.length === 0
    || session.cookies.length > maximumSessionCookies
  ) {
    throw sessionStoreError()
  }
  const cookies = session.cookies.map(parseCookie)
  if (cookies.reduce(
    (total, cookie) => total
      + Buffer.byteLength(cookie.name, "utf8")
      + Buffer.byteLength(cookie.value, "utf8"),
    0,
  ) > maximumCookieBytes) {
    throw sessionStoreError()
  }
  const identities = new Set<string>()
  for (const cookie of cookies) {
    const identity = `${cookie.name}\u0000${cookie.domain}\u0000${cookie.path}`
    if (identities.has(identity)) throw sessionStoreError()
    identities.add(identity)
  }
  return {
    authorizedAt: Number(session.authorizedAt),
    cookies,
    revision: session.revision,
    schema: webSessionSchema,
  }
}

export function webSessionCookieHeader(
  cookies: readonly WebSessionCookie[],
  requestUrl: string | URL,
  nowMilliseconds = Date.now(),
) {
  const url = requestUrl instanceof URL ? requestUrl : new URL(requestUrl)
  if (url.protocol !== "https:" || url.origin !== xiaoYunqueCookieOrigin) return ""
  return cookies.filter((cookie) => (
    (cookie.expiresAt === undefined || cookie.expiresAt > nowMilliseconds)
    && cookie.domain === ""
    && cookie.path === "/"
    && cookie.secure
    && allowedStoredCookieNames.has(cookie.name)
  )).map(({ name, value }) => `${name}=${value}`).join("; ")
}

export function webSessionIsUsable(session: StoredWebSession, nowMilliseconds = Date.now()) {
  return webSessionCookieHeader(session.cookies, `${xiaoYunqueCookieOrigin}/`, nowMilliseconds) !== ""
}

async function requirePrivateDirectory(directory: string) {
  await mkdir(directory, { mode: 0o700, recursive: true })
  const info = await lstat(directory)
  if (!info.isDirectory() || info.isSymbolicLink()) throw sessionStoreError()
  await chmod(directory, 0o700)
}

async function inspectExistingTarget(filePath: string) {
  try {
    const info = await lstat(filePath)
    if (!info.isFile() || info.isSymbolicLink()) throw sessionStoreError()
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
  }
}

export class FileWebSessionStore implements WebSessionStore {
  constructor(readonly filePath: string) {}

  async read() {
    let handle
    try {
      handle = await open(this.filePath, noFollowReadFlags())
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null
      throw sessionStoreError()
    }
    try {
      const info = await handle.stat()
      if (
        !info.isFile()
        || (info.mode & 0o077) !== 0
        || info.size <= 0
        || info.size > maximumSessionFileBytes
      ) {
        throw sessionStoreError()
      }
      const bytes = await handle.readFile()
      if (bytes.byteLength !== info.size || bytes.byteLength > maximumSessionFileBytes) {
        throw sessionStoreError()
      }
      let text: string
      try {
        text = new TextDecoder("utf-8", { fatal: true }).decode(bytes)
      } catch {
        throw sessionStoreError()
      }
      try {
        return parseStoredWebSession(JSON.parse(text) as unknown)
      } catch {
        throw sessionStoreError()
      }
    } finally {
      await handle.close()
    }
  }

  async write(session: StoredWebSession) {
    const normalized = parseStoredWebSession(session)
    const serialized = `${JSON.stringify(normalized)}\n`
    if (Buffer.byteLength(serialized, "utf8") > maximumSessionFileBytes) throw sessionStoreError()
    const directory = path.dirname(this.filePath)
    await requirePrivateDirectory(directory)
    await inspectExistingTarget(this.filePath)
    const temporaryPath = path.join(directory, `.web-session-${crypto.randomUUID()}.tmp`)
    let handle
    try {
      handle = await open(
        temporaryPath,
        exclusiveNoFollowWriteFlags(),
        0o600,
      )
      await handle.chmod(0o600)
      const temporaryInfo = await handle.stat()
      if (!temporaryInfo.isFile() || (temporaryInfo.mode & 0o777) !== 0o600) throw sessionStoreError()
      await handle.writeFile(serialized, "utf8")
      await handle.sync()
      await handle.close()
      handle = undefined
      await rename(temporaryPath, this.filePath)
      if (process.platform !== "win32") {
        try {
          const directoryHandle = await open(directory, "r")
          try {
            await directoryHandle.sync()
          } finally {
            await directoryHandle.close()
          }
        } catch {
          // The atomic rename is the commit point and the published file was
          // already prepared as mode 0600 and fsynced. Do not report a failed
          // reauthorization after a complete new session replaced the old one.
        }
      }
    } catch {
      throw sessionStoreError()
    } finally {
      await handle?.close().catch(() => undefined)
      await rm(temporaryPath, { force: true }).catch(() => undefined)
    }
  }

  async clear() {
    try {
      const info = await lstat(this.filePath)
      // Unlinking a symlink is safe and never follows its target. This lets an
      // explicit sign-out/reauthorize repair a tampered cache while reads still
      // fail closed and writes never replace an uninspected target.
      if (!info.isFile() && !info.isSymbolicLink()) throw sessionStoreError()
      await rm(this.filePath)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return
      if (error instanceof Error && error.message === sessionStoreError().message) throw error
      throw sessionStoreError()
    }
  }
}
