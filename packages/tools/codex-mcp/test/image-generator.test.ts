import { afterEach, describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import type { AppServerMessage, CodexAppServerClient } from "../src/app-server-client.ts"
import type { GenerationCall } from "../src/contracts.ts"
import { CodexImageGenerator } from "../src/image-generator.ts"

const temporaryDirectories: string[] = []
const onePixelPng = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => fs.rm(directory, { force: true, recursive: true })))
})

class FakeClient {
  readonly listeners = new Set<(message: AppServerMessage) => void>()

  onMessage(listener: (message: AppServerMessage) => void) {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  async request(method: string) {
    if (method === "modelProvider/capabilities/read") return { imageGeneration: true }
    if (method === "thread/start") return { thread: { id: "thread-1" } }
    if (method === "turn/start") {
      queueMicrotask(() => {
        this.emit("item/completed", {
          item: { result: onePixelPng, status: "completed", type: "imageGeneration" },
          threadId: "thread-1",
          turnId: "turn-1",
        })
        this.emit("turn/completed", { threadId: "thread-1", turn: { id: "turn-1", status: "completed" } })
      })
      return { turn: { id: "turn-1" } }
    }
    if (method === "turn/interrupt") return {}
    throw new Error(`unexpected ${method}`)
  }

  emit(method: string, params: unknown) {
    for (const listener of this.listeners) listener({ method, params })
  }
}

describe("Codex GPT Image 2 generation", () => {
  test("materializes the completed Codex image beneath output_directory", async () => {
    const output = await fs.mkdtemp(path.join(os.tmpdir(), "convax-codex-image-test-"))
    temporaryDirectories.push(output)
    const call: GenerationCall = {
      operation_id: "operation-1",
      output: "image",
      output_directory: output,
      prompt: "one quiet pixel",
      references: [],
      schema: "convax.generation-call/1",
    }
    const artifacts = await new CodexImageGenerator(new FakeClient() as unknown as CodexAppServerClient).generate(call)
    expect(artifacts).toEqual([{
      mimeType: "image/png",
      name: "codex-gpt-image-2-operation-1.png",
      path: "codex-gpt-image-2-operation-1.png",
    }])
    expect((await fs.stat(path.join(output, artifacts[0]!.path))).size).toBeGreaterThan(0)
  })
})
