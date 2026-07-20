import { describe, expect, test } from "bun:test"
import type { GenerationCall } from "../src/contracts.ts"
import { McpServer } from "../src/mcp-server.ts"
import type { XiaoYunqueModel } from "../src/models.ts"

const encoder = new TextEncoder()
const unusedService = {
  async authorize(): Promise<never> { throw new Error("service call was not expected") },
  async cancelAuthorization(): Promise<never> { throw new Error("service call was not expected") },
  async completeAuthorization(): Promise<never> { throw new Error("service call was not expected") },
  async reauthorize(): Promise<never> { throw new Error("service call was not expected") },
  async signOut(): Promise<never> { throw new Error("service call was not expected") },
  async status(): Promise<never> { throw new Error("service call was not expected") },
}

function generationRequest(operationId: string) {
  return `${JSON.stringify({
    id: 1,
    jsonrpc: "2.0",
    method: "tools/call",
    params: {
      arguments: {
        operation_id: operationId,
        output: "image",
        output_directory: "/tmp",
        prompt: "Generate an image",
        references: [],
        schema: "convax.generation-call/1",
      },
      name: "image.seedream_4.5",
    },
  })}\n`
}

function requestStream(operationId: string) {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(generationRequest(operationId)))
    },
  })
}

describe("MCP server lifecycle", () => {
  test("shutdown aborts cancellable work but drains an abort-insensitive persistence tail", async () => {
    let start!: () => void
    const started = new Promise<void>((resolve) => { start = resolve })
    let releasePersistence!: () => void
    const persistenceReleased = new Promise<void>((resolve) => { releasePersistence = resolve })
    let persisted = false
    let observedSignal: AbortSignal | undefined
    const server = new McpServer({
      async generate(_call: GenerationCall, _model: XiaoYunqueModel, signal: AbortSignal) {
        observedSignal = signal
        start()
        // This models the submitted-record save: it deliberately ignores the
        // request signal once a billable submission has returned.
        await persistenceReleased
        persisted = true
        throw new DOMException("Generation was cancelled", "AbortError")
      },
    }, unusedService)
    const running = server.run(requestStream("drain-persistence-tail"))
    await started

    const draining = server.shutdown(1_000)
    expect(observedSignal?.aborted).toBeTrue()
    await Bun.sleep(10)
    expect(persisted).toBeFalse()
    releasePersistence()

    expect(await draining).toBeTrue()
    expect(persisted).toBeTrue()
    await running
  })

  test("shutdown returns after its grace period when a handler cannot drain", async () => {
    let start!: () => void
    const started = new Promise<void>((resolve) => { start = resolve })
    const never = new Promise<never>(() => undefined)
    const server = new McpServer({
      async generate() {
        start()
        return never
      },
    }, unusedService)
    const running = server.run(requestStream("bounded-shutdown"))
    await started

    const before = performance.now()
    expect(await server.shutdown(25)).toBeFalse()
    expect(performance.now() - before).toBeGreaterThanOrEqual(20)

    // The synthetic handler intentionally never settles. Its unresolved
    // promise has no active resources, while closing the input lets run end.
    await running
  })
})
