import { afterEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, readdir, rm, truncate, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import type { GenerationCall } from "../src/contracts.ts"
import { fingerprintGenerationCall, OperationStore } from "../src/operation-store.ts"

const png = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0])
const imageModel = "seedream_4.5" as const
const directories: string[] = []

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { force: true, recursive: true })))
})

function call(overrides: Partial<GenerationCall> & Pick<GenerationCall, "operation_id" | "output" | "output_directory">): GenerationCall {
  return {
    schema: "convax.generation-call/1",
    prompt: "Create a quiet paper-cut landscape",
    references: [],
    ...overrides,
  }
}

describe("XiaoYunque operation store", () => {
  test("fingerprints references without buffering oversized files and honors cancellation", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "xiaoyunque-fingerprint-"))
    directories.push(directory)
    const output = path.join(directory, "output")
    const referencePath = path.join(directory, "reference.png")
    const oversizedPath = path.join(directory, "oversized.png")
    await Promise.all([mkdir(output), writeFile(referencePath, png), writeFile(oversizedPath, "")])
    const generation = call({
      operation_id: "fingerprint-reference",
      output: "image",
      output_directory: output,
      references: [{
        kind: "file",
        mime_type: "image/png",
        name: "reference.png",
        node_id: "reference",
        path: referencePath,
        role: "reference_image",
      }],
    })
    const expected = await fingerprintGenerationCall(generation, imageModel)
    expect(await fingerprintGenerationCall(generation, imageModel, new AbortController().signal)).toBe(expected)

    let abortChecks = 0
    const nativeSignal = new AbortController().signal
    const streamingAbortSignal = new Proxy(nativeSignal, {
      get(target, property) {
        if (property === "aborted") return ++abortChecks >= 6
        const value = Reflect.get(target, property, target) as unknown
        return typeof value === "function" ? value.bind(target) : value
      },
    })
    await expect(fingerprintGenerationCall(generation, imageModel, streamingAbortSignal))
      .rejects.toMatchObject({ name: "AbortError" })
    expect(abortChecks).toBeGreaterThanOrEqual(6)

    const videoGeneration = { ...generation, output: "video" as const }
    expect(await fingerprintGenerationCall(videoGeneration, "seedance2.0_vision"))
      .not.toBe(await fingerprintGenerationCall(videoGeneration, "seedance2.0_fast_vision"))

    await truncate(oversizedPath, 200 * 1024 * 1024 + 1)
    await expect(fingerprintGenerationCall({
      ...generation,
      references: [{
        kind: "file",
        mime_type: "image/png",
        name: "oversized.png",
        node_id: "oversized-reference",
        path: oversizedPath,
        role: "reference_image",
      }],
    }, imageModel)).rejects.toThrow("cannot exceed 200 MiB")
  })

  test("retains concurrent writes from different store instances", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "xiaoyunque-operation-store-"))
    directories.push(directory)
    const storePath = path.join(directory, "state", "operations.json")
    const storeOne = new OperationStore(storePath, { lockPollIntervalMs: 1 })
    const storeTwo = new OperationStore(storePath, { lockPollIntervalMs: 1 })
    const createdAt = new Date().toISOString()

    await Promise.all([
      storeOne.save("operation-one", {
        createdAt,
        fingerprint: "fingerprint-one",
        output: "image",
        runId: "run-one",
        status: "submitted",
        threadId: "thread-one",
      }),
      storeTwo.save("operation-two", {
        createdAt,
        fingerprint: "fingerprint-two",
        output: "video",
        runId: "run-two",
        status: "submitted",
        threadId: "thread-two",
      }),
    ])

    expect(await storeOne.find("operation-one")).toMatchObject({ runId: "run-one", status: "submitted" })
    expect(await storeOne.find("operation-two")).toMatchObject({ runId: "run-two", status: "submitted" })
    expect(await readdir(path.join(directory, "state", ".operation-records"))).toHaveLength(2)
  })

  test("never silently evicts old idempotency records", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "xiaoyunque-operation-retention-"))
    directories.push(directory)
    const stateDirectory = path.join(directory, "state")
    const storePath = path.join(stateDirectory, "operations.json")
    await mkdir(stateDirectory)
    const operations: Record<string, unknown> = {}
    for (let index = 0; index < 205; index += 1) {
      operations[`old-operation-${index}`] = {
        createdAt: "2000-01-01T00:00:00.000Z",
        fingerprint: `old-fingerprint-${index}`,
        output: "image",
        runId: `old-run-${index}`,
        status: "submitted",
        threadId: `old-thread-${index}`,
      }
    }
    await writeFile(storePath, `${JSON.stringify(operations)}\n`, { mode: 0o600 })

    const store = new OperationStore(storePath)
    await store.save("new-operation", {
      createdAt: new Date().toISOString(),
      fingerprint: "new-fingerprint",
      output: "image",
      runId: "new-run",
      status: "submitted",
      threadId: "new-thread",
    })

    const legacy = JSON.parse(await readFile(storePath, "utf8")) as Record<string, unknown>
    expect(Object.keys(legacy)).toHaveLength(205)
    expect(await store.find("old-operation-0")).toBeDefined()
    expect(await store.find("old-operation-204")).toBeDefined()
    expect(await store.find("new-operation")).toBeDefined()
  })

  test("fails closed when another operation owner exceeds the wait timeout", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "xiaoyunque-operation-timeout-"))
    directories.push(directory)
    const storePath = path.join(directory, "state", "operations.json")
    const owner = new OperationStore(storePath, { lockPollIntervalMs: 1, lockWaitTimeoutMs: 1_000 })
    const waiter = new OperationStore(storePath, { lockPollIntervalMs: 1, lockWaitTimeoutMs: 20 })
    let releaseOwner!: () => void
    let announceOwner!: () => void
    const ownerReady = new Promise<void>((resolve) => { announceOwner = resolve })
    const keepOwner = new Promise<void>((resolve) => { releaseOwner = resolve })
    const ownerRun = owner.withOperationLock("operation", new AbortController().signal, async () => {
      announceOwner()
      await keepOwner
    })
    await ownerReady
    let waiterEntered = false

    await expect(waiter.withOperationLock("operation", new AbortController().signal, async () => {
      waiterEntered = true
    })).rejects.toThrow("use a new operation id only after confirming")
    expect(waiterEntered).toBeFalse()
    releaseOwner()
    await ownerRun
  })

  test("cancels an operation-lock wait without entering the operation", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "xiaoyunque-operation-abort-"))
    directories.push(directory)
    const storePath = path.join(directory, "state", "operations.json")
    const owner = new OperationStore(storePath, { lockPollIntervalMs: 1 })
    const waiter = new OperationStore(storePath, { lockPollIntervalMs: 1 })
    let releaseOwner!: () => void
    let announceOwner!: () => void
    const ownerReady = new Promise<void>((resolve) => { announceOwner = resolve })
    const keepOwner = new Promise<void>((resolve) => { releaseOwner = resolve })
    const ownerRun = owner.withOperationLock("operation", new AbortController().signal, async () => {
      announceOwner()
      await keepOwner
    })
    await ownerReady
    const controller = new AbortController()
    let waiterEntered = false
    const waiting = waiter.withOperationLock("operation", controller.signal, async () => {
      waiterEntered = true
    })
    controller.abort()

    await expect(waiting).rejects.toMatchObject({ name: "AbortError" })
    expect(waiterEntered).toBeFalse()
    releaseOwner()
    await ownerRun
  })

  test("uses a durable record despite a crash-left operation lock", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "xiaoyunque-operation-crash-record-"))
    directories.push(directory)
    const stateDirectory = path.join(directory, "state")
    const storePath = path.join(stateDirectory, "operations.json")
    const store = new OperationStore(storePath, { lockWaitTimeoutMs: 600_000 })
    await store.save("completed-operation", {
      createdAt: new Date().toISOString(),
      fingerprint: "fingerprint",
      output: "image",
      runId: "run",
      status: "submitted",
      threadId: "thread",
    })
    const lockDirectory = path.join(stateDirectory, ".operation-locks")
    await mkdir(lockDirectory, { mode: 0o700 })
    const digest = new Bun.CryptoHasher("sha256").update("completed-operation").digest("hex")
    await writeFile(path.join(lockDirectory, `${digest}.lock`), `${JSON.stringify({
      pid: process.pid,
      token: "token-from-a-crashed-process-incarnation",
    })}\n`, { mode: 0o600 })
    let entered = false

    await store.withOperationLock("completed-operation", new AbortController().signal, async () => {
      entered = true
      expect(await store.find("completed-operation")).toMatchObject({ status: "submitted" })
    })
    expect(entered).toBeTrue()

    await store.save("uncertain-operation", {
      createdAt: new Date().toISOString(),
      fingerprint: "fingerprint",
      output: "image",
      status: "submitting",
    })
    const uncertainDigest = new Bun.CryptoHasher("sha256").update("uncertain-operation").digest("hex")
    await writeFile(path.join(lockDirectory, `${uncertainDigest}.lock`), "crashed-owner\n", { mode: 0o600 })
    await expect(store.withOperationLock("uncertain-operation", new AbortController().signal, async () => {
      const record = await store.find("uncertain-operation")
      if (record?.status === "submitting") throw new Error("fail closed on submitting tombstone")
    })).rejects.toThrow("fail closed on submitting tombstone")
  })

  test("fails closed on a crash-left lock that has no durable record", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "xiaoyunque-operation-crash-no-record-"))
    directories.push(directory)
    const stateDirectory = path.join(directory, "state")
    const lockDirectory = path.join(stateDirectory, ".operation-locks")
    await mkdir(lockDirectory, { recursive: true, mode: 0o700 })
    const digest = new Bun.CryptoHasher("sha256").update("unknown-operation").digest("hex")
    await writeFile(path.join(lockDirectory, `${digest}.lock`), "crashed-owner\n", { mode: 0o600 })
    const store = new OperationStore(path.join(stateDirectory, "operations.json"), {
      lockPollIntervalMs: 1,
      lockWaitTimeoutMs: 20,
    })
    let entered = false

    await expect(store.withOperationLock("unknown-operation", new AbortController().signal, async () => {
      entered = true
    })).rejects.toThrow("use a new operation id only after confirming")
    expect(entered).toBeFalse()
  })
})
