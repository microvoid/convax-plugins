import fs from "node:fs/promises"
import path from "node:path"
import type { CodexAppServerClient } from "./app-server-client.ts"
import type { GenerationArtifact, GenerationCall } from "./contracts.ts"

const maximumImageBytes = 32 * 1024 * 1024
const imageOrchestratorModel = "gpt-5.6-terra"

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

function safeStem(operationId: string) {
  const value = operationId.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "")
  return (value || "image").slice(0, 80)
}

function decodeResult(value: string) {
  let mimeType = "image/png"
  let encoded = value
  if (value.startsWith("data:")) {
    const match = value.match(/^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=\r\n]+)$/u)
    if (!match) throw new Error("Local Codex returned an unsupported image result")
    mimeType = match[1]!
    encoded = match[2]!
  }
  const bytes = Buffer.from(encoded, "base64")
  if (bytes.length === 0 || bytes.length > maximumImageBytes) {
    throw new Error("Local Codex returned an invalid image result")
  }
  return { bytes, mimeType }
}

function extensionFor(mimeType: string) {
  return mimeType === "image/jpeg" ? "jpg" : mimeType === "image/webp" ? "webp" : "png"
}

async function writeExclusive(directory: string, stem: string, mimeType: string, bytes: Uint8Array) {
  await fs.mkdir(directory, { recursive: true })
  const extension = extensionFor(mimeType)
  for (let index = 0; index < 1_000; index += 1) {
    const name = `${stem}${index === 0 ? "" : `-${index + 1}`}.${extension}`
    const destination = path.join(directory, name)
    let handle: fs.FileHandle | undefined
    try {
      handle = await fs.open(destination, "wx", 0o600)
      await handle.writeFile(bytes)
      return { destination, name }
    } catch (error) {
      if (!(error && typeof error === "object" && "code" in error && error.code === "EEXIST")) throw error
    } finally {
      await handle?.close()
    }
  }
  throw new Error("Unable to allocate a unique image output name")
}

export class CodexImageGenerator {
  constructor(private readonly client: CodexAppServerClient) {}

  async generate(call: GenerationCall, signal?: AbortSignal): Promise<GenerationArtifact[]> {
    const capabilities = record(await this.client.request("modelProvider/capabilities/read", {}, {
      signal,
      timeoutMs: 10_000,
    }))
    if (capabilities?.imageGeneration !== true) {
      throw new Error("The bound local Codex does not expose GPT Image 2 generation")
    }
    const started = record(await this.client.request("thread/start", {
      approvalPolicy: "never",
      baseInstructions: [
        "Generate exactly one image for the user request.",
        "Use the built-in image_gen image-generation tool exactly once.",
        "The image model is GPT Image 2. Do not use shell, files, web, MCP, or any other tool.",
        "Do not ask follow-up questions. Preserve the supplied reference images when present.",
      ].join("\n"),
      cwd: process.cwd(),
      developerInstructions: "Return the generated image without performing any other side effect.",
      dynamicTools: [],
      environments: [],
      ephemeral: true,
      experimentalRawEvents: true,
      model: imageOrchestratorModel,
      modelProvider: "openai",
      sandbox: "read-only",
      selectedCapabilityRoots: [],
      serviceName: "convax_codex_image",
    }, { signal, timeoutMs: 15_000 }))
    const thread = record(started?.thread)
    if (typeof thread?.id !== "string") throw new Error("Local Codex did not start an image thread")
    const threadId = thread.id
    let image: { result: string; savedPath?: string } | undefined
    let activeTurnId: string | undefined
    let resolveCompleted!: (status: string) => void
    const completed = new Promise<string>((resolve) => { resolveCompleted = resolve })
    const unsubscribe = this.client.onMessage((message) => {
      const params = record(message.params)
      if (params?.threadId !== threadId) return
      if (message.method === "item/completed") {
        const item = record(params.item)
        if (item?.type === "imageGeneration" && item.status === "completed" && typeof item.result === "string") {
          image = {
            result: item.result,
            ...(typeof item.savedPath === "string" ? { savedPath: item.savedPath } : {}),
          }
        }
      } else if (message.method === "turn/completed") {
        const turn = record(params.turn)
        if (!activeTurnId || turn?.id === activeTurnId) resolveCompleted(typeof turn?.status === "string" ? turn.status : "failed")
      }
    })
    const onAbort = () => {
      if (activeTurnId) {
        void this.client.request("turn/interrupt", { threadId, turnId: activeTurnId }, { timeoutMs: 5_000 }).catch(() => undefined)
      }
    }
    signal?.addEventListener("abort", onAbort, { once: true })
    try {
      const input = [
        { text: call.prompt, text_elements: [], type: "text" },
        ...call.references.map((reference) => ({ path: reference.path, type: "localImage" })),
      ]
      const turnResult = record(await this.client.request("turn/start", { input, threadId }, {
        signal,
        timeoutMs: 15_000,
      }))
      const turn = record(turnResult?.turn)
      if (typeof turn?.id !== "string") throw new Error("Local Codex did not start GPT Image 2 generation")
      activeTurnId = turn.id
      const status = await completed
      if (status !== "completed" || !image) throw new Error("Local Codex GPT Image 2 generation failed")
      let decoded: { bytes: Uint8Array; mimeType: string }
      if (image.savedPath) {
        const bytes = await fs.readFile(image.savedPath)
        if (bytes.length === 0 || bytes.length > maximumImageBytes) throw new Error("Local Codex returned an invalid image file")
        decoded = { bytes, mimeType: "image/png" }
      } else {
        decoded = decodeResult(image.result)
      }
      const output = await writeExclusive(
        call.output_directory,
        `codex-gpt-image-2-${safeStem(call.operation_id)}`,
        decoded.mimeType,
        decoded.bytes,
      )
      return [{ mimeType: decoded.mimeType, name: output.name, path: output.name }]
    } finally {
      signal?.removeEventListener("abort", onAbort)
      unsubscribe()
    }
  }
}
