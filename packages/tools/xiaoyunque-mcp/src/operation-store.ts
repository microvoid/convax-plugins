import { chmod, lstat, mkdir, open, readFile, rename, rm } from "node:fs/promises"
import path from "node:path"
import type { GenerationCall } from "./contracts.ts"
import type { XiaoYunqueModel } from "./models.ts"
import { exclusiveNoFollowWriteFlags } from "./private-file.ts"
import type { RemoteTask } from "./xiaoyunque-api.ts"

export interface PendingOperationRecord {
  createdAt: string
  fingerprint: string
  output: "image" | "video"
  status: "submitting"
}

export interface SubmittedOperationRecord extends RemoteTask {
  createdAt: string
  fingerprint: string
  output: "image" | "video"
  status: "submitted"
}

export type OperationRecord = PendingOperationRecord | SubmittedOperationRecord
type OperationMap = Record<string, OperationRecord>

export interface OperationStoreOptions {
  lockPollIntervalMs?: number
  lockWaitTimeoutMs?: number
}

const liveProcessLockTokens = new Set<string>()
const maxReferenceBytes = 200 * 1024 * 1024

function abortError() {
  return new DOMException("Operation lock wait was cancelled", "AbortError")
}

function throwIfAborted(signal?: AbortSignal) {
  if (signal?.aborted) throw abortError()
}

function fingerprintAbortError() {
  return new DOMException("Generation fingerprinting was cancelled", "AbortError")
}

function throwIfFingerprintAborted(signal?: AbortSignal) {
  if (signal?.aborted) throw fingerprintAbortError()
}

async function abortableDelay(milliseconds: number, signal?: AbortSignal) {
  throwIfAborted(signal)
  await new Promise<void>((resolve, reject) => {
    let settled = false
    const finish = (operation: () => void) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener("abort", onAbort)
      operation()
    }
    const onAbort = () => finish(() => reject(abortError()))
    const timer = setTimeout(() => finish(resolve), milliseconds)
    signal?.addEventListener("abort", onAbort, { once: true })
  })
}

function isCurrentUserOwner(uid: number) {
  return typeof process.getuid !== "function" || uid === process.getuid()
}

function processIsAlive(pid: number) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false
  if (pid === process.pid) return true
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH"
  }
}

async function hashFile(filePath: string, signal?: AbortSignal) {
  throwIfFingerprintAborted(signal)
  const info = await lstat(filePath)
  if (!info.isFile() || info.isSymbolicLink()) throw new Error("Generation reference is not a regular file")
  if (info.size > maxReferenceBytes) throw new Error("XiaoYunque references cannot exceed 200 MiB")
  throwIfFingerprintAborted(signal)
  const hasher = new Bun.CryptoHasher("sha256")
  const reader = Bun.file(filePath).stream().getReader()
  let abortCancellation: Promise<void> | undefined
  const onAbort = () => {
    abortCancellation ??= reader.cancel(fingerprintAbortError()).catch(() => undefined)
  }
  signal?.addEventListener("abort", onAbort, { once: true })
  let total = 0
  try {
    throwIfFingerprintAborted(signal)
    while (true) {
      const { done, value } = await reader.read()
      throwIfFingerprintAborted(signal)
      if (done) break
      total += value.byteLength
      if (total > maxReferenceBytes) {
        await reader.cancel().catch(() => undefined)
        throw new Error("XiaoYunque references cannot exceed 200 MiB")
      }
      hasher.update(value)
    }
    throwIfFingerprintAborted(signal)
    return hasher.digest("hex")
  } finally {
    signal?.removeEventListener("abort", onAbort)
    await abortCancellation
    try {
      reader.releaseLock()
    } catch {
      // The reader can already be released after cancellation.
    }
  }
}

export async function fingerprintGenerationCall(
  call: GenerationCall,
  model: XiaoYunqueModel,
  signal?: AbortSignal,
) {
  throwIfFingerprintAborted(signal)
  const references = []
  for (const reference of call.references) {
    throwIfFingerprintAborted(signal)
    references.push(reference.kind === "text"
      ? { kind: "text", nodeId: reference.node_id, role: reference.role, text: reference.text }
      : {
          kind: "file",
          mimeType: reference.mime_type,
          name: reference.name,
          nodeId: reference.node_id,
          role: reference.role,
          sha256: await hashFile(reference.path, signal),
        })
  }
  throwIfFingerprintAborted(signal)
  const payload = JSON.stringify({ model, output: call.output, prompt: call.prompt, references })
  return new Bun.CryptoHasher("sha256").update(payload).digest("hex")
}

export class OperationStore {
  readonly #lockPollIntervalMs: number
  readonly #lockWaitTimeoutMs: number

  constructor(readonly filePath: string, options: OperationStoreOptions = {}) {
    this.#lockPollIntervalMs = options.lockPollIntervalMs ?? 50
    this.#lockWaitTimeoutMs = options.lockWaitTimeoutMs ?? 10 * 60_000
    if (!Number.isFinite(this.#lockPollIntervalMs) || this.#lockPollIntervalMs <= 0) {
      throw new Error("Operation lock poll interval must be positive")
    }
    if (!Number.isFinite(this.#lockWaitTimeoutMs) || this.#lockWaitTimeoutMs <= 0) {
      throw new Error("Operation lock timeout must be positive")
    }
  }

  async find(operationId: string) {
    const current = await this.#readRecord(operationId)
    if (current) return current
    return (await this.#readLegacy())[operationId] ?? null
  }

  async save(operationId: string, record: OperationRecord, signal?: AbortSignal) {
    throwIfAborted(signal)
    // Every operation owns an independent atomic record. Different processes
    // can therefore persist unrelated operations without a global mutex whose
    // crash residue could block all future generations. These records are
    // durable idempotency keys and are never silently pruned.
    await this.#writeRecord(operationId, record)
  }

  async withOperationLock<T>(
    operationId: string,
    signal: AbortSignal,
    operation: () => Promise<T>,
  ): Promise<T> {
    throwIfAborted(signal)
    const lockDirectory = path.join(path.dirname(this.filePath), ".operation-locks")
    const lockPath = path.join(lockDirectory, `${this.#operationDigest(operationId)}.lock`)
    // A durable submitted record is always authoritative. A submitting
    // tombstone may still have a live owner finishing the short submit/save
    // sequence, so wait for that owner; a dead/legacy owner is safe to bypass
    // because the callback will fail closed on the tombstone.
    const durable = await this.find(operationId)
    if (durable?.status === "submitted"
      || (durable?.status === "submitting" && !(await this.#lockOwnerIsAlive(lockPath)))) {
      return operation()
    }
    await this.#ensurePrivateDirectory(lockDirectory)
    return this.#withFileLock(
      lockPath,
      "generation operation",
      signal,
      operation,
    )
  }

  #operationDigest(operationId: string) {
    return new Bun.CryptoHasher("sha256").update(operationId).digest("hex")
  }

  #recordDirectory() {
    return path.join(path.dirname(this.filePath), ".operation-records")
  }

  #recordPath(operationId: string) {
    return path.join(this.#recordDirectory(), `${this.#operationDigest(operationId)}.json`)
  }

  async #withFileLock<T>(
    lockPath: string,
    label: string,
    signal: AbortSignal | undefined,
    operation: () => Promise<T>,
  ): Promise<T> {
    const release = await this.#acquireFileLock(lockPath, label, signal)
    try {
      throwIfAborted(signal)
      return await operation()
    } finally {
      await release()
    }
  }

  async #acquireFileLock(lockPath: string, label: string, signal?: AbortSignal) {
    await this.#ensurePrivateDirectory(path.dirname(lockPath))
    const deadline = Date.now() + this.#lockWaitTimeoutMs
    const token = crypto.randomUUID()
    while (true) {
      throwIfAborted(signal)
      try {
        const handle = await open(lockPath, exclusiveNoFollowWriteFlags(), 0o600)
        try {
          await handle.chmod(0o600)
          const lockInfo = await handle.stat()
          if (!lockInfo.isFile() || (lockInfo.mode & 0o777) !== 0o600) {
            throw new Error(`XiaoYunque ${label} lock is not private`)
          }
          await handle.writeFile(`${JSON.stringify({ pid: process.pid, token })}\n`, "utf8")
          await handle.sync()
        } catch (error) {
          await handle.close().catch(() => undefined)
          await rm(lockPath, { force: true }).catch(() => undefined)
          throw error
        }
        await handle.close()
        liveProcessLockTokens.add(token)
        return async () => {
          try {
            const info = await lstat(lockPath)
            if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o077) !== 0 || !isCurrentUserOwner(info.uid)) {
              throw new Error(`XiaoYunque ${label} lock ownership changed`)
            }
            const currentOwner = this.#parseLockOwner(await readFile(lockPath, "utf8"))
            if (currentOwner?.token !== token) throw new Error(`XiaoYunque ${label} lock ownership changed`)
            await rm(lockPath)
          } finally {
            liveProcessLockTokens.delete(token)
          }
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
        const existing = await this.#existingLockIsSafe(lockPath)
        if (!existing) continue
        if (Date.now() >= deadline) {
          throw new Error(
            `Timed out waiting for XiaoYunque ${label} lock; `
            + "use a new operation id only after confirming that no submission was accepted",
          )
        }
        await abortableDelay(Math.min(this.#lockPollIntervalMs, Math.max(1, deadline - Date.now())), signal)
      }
    }
  }

  async #existingLockIsSafe(lockPath: string) {
    try {
      const info = await lstat(lockPath)
      if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o077) !== 0 || !isCurrentUserOwner(info.uid)) {
        throw new Error("XiaoYunque operation lock is not private")
      }
      return true
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false
      throw error
    }
  }

  #parseLockOwner(value: string) {
    try {
      const owner = JSON.parse(value) as { pid?: unknown; token?: unknown }
      return Number.isSafeInteger(owner.pid) && typeof owner.token === "string" && owner.token
        ? { pid: owner.pid as number, token: owner.token }
        : null
    } catch {
      return null
    }
  }

  async #lockOwnerIsAlive(lockPath: string) {
    try {
      if (!await this.#existingLockIsSafe(lockPath)) return false
      const owner = this.#parseLockOwner(await readFile(lockPath, "utf8"))
      if (!owner) return false
      return owner.pid === process.pid ? liveProcessLockTokens.has(owner.token) : processIsAlive(owner.pid)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false
      throw error
    }
  }

  async #ensurePrivateDirectory(directory: string) {
    await mkdir(directory, { recursive: true, mode: 0o700 })
    const info = await lstat(directory)
    if (!info.isDirectory() || info.isSymbolicLink() || !isCurrentUserOwner(info.uid)) {
      throw new Error("XiaoYunque operation state directory is not host-owned")
    }
    await chmod(directory, 0o700)
  }

  async #readRecord(operationId: string): Promise<OperationRecord | null> {
    const recordPath = this.#recordPath(operationId)
    try {
      const info = await lstat(recordPath)
      if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o077) !== 0 || !isCurrentUserOwner(info.uid)) {
        throw new Error("XiaoYunque operation record is not private")
      }
      const value = JSON.parse(await readFile(recordPath, "utf8")) as unknown
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Operation record is invalid")
      const envelope = value as { operationId?: unknown; record?: unknown; schema?: unknown }
      if (envelope.schema !== "xiaoyunque.operation/1" || envelope.operationId !== operationId
        || !envelope.record || typeof envelope.record !== "object" || Array.isArray(envelope.record)) {
        throw new Error("Operation record is invalid")
      }
      return envelope.record as OperationRecord
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null
      throw error
    }
  }

  async #readLegacy(): Promise<OperationMap> {
    try {
      const info = await lstat(this.filePath)
      if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o077) !== 0 || !isCurrentUserOwner(info.uid)) {
        throw new Error("XiaoYunque operation cache is not private")
      }
      const value = JSON.parse(await readFile(this.filePath, "utf8")) as unknown
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Operation cache is invalid")
      return value as OperationMap
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return {}
      throw error
    }
  }

  async #writeRecord(operationId: string, record: OperationRecord) {
    const directory = this.#recordDirectory()
    await this.#ensurePrivateDirectory(directory)
    const recordPath = this.#recordPath(operationId)
    const temporaryPath = path.join(directory, `.${this.#operationDigest(operationId)}-${crypto.randomUUID()}.tmp`)
    const temporary = await open(temporaryPath, exclusiveNoFollowWriteFlags(), 0o600)
    try {
      await temporary.chmod(0o600)
      const temporaryInfo = await temporary.stat()
      if (!temporaryInfo.isFile() || (temporaryInfo.mode & 0o777) !== 0o600) {
        throw new Error("XiaoYunque operation record temporary file is not private")
      }
      await temporary.writeFile(`${JSON.stringify({
        operationId,
        record,
        schema: "xiaoyunque.operation/1",
      })}\n`, "utf8")
      await temporary.sync()
      await temporary.close()
      await rename(temporaryPath, recordPath)
      await chmod(recordPath, 0o600)
      if (process.platform !== "win32") {
        const directoryHandle = await open(directory, "r")
        try {
          await directoryHandle.sync()
        } finally {
          await directoryHandle.close()
        }
      }
    } catch (error) {
      await temporary.close().catch(() => undefined)
      throw error
    } finally {
      await rm(temporaryPath, { force: true })
    }
  }
}
