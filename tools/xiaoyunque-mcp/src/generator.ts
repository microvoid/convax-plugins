import { lstat, open, rename, rm } from "node:fs/promises"
import path from "node:path"
import type { WebSessionAuthorizer } from "./authorization-state.ts"
import type { FileGenerationReference, GenerationArtifact, GenerationCall, GenerationOutput } from "./contracts.ts"
import {
  modelSupportsOutput,
  type XiaoYunqueImageModel,
  type XiaoYunqueModel,
  type XiaoYunqueVideoModel,
} from "./models.ts"
import { fingerprintGenerationCall, OperationStore } from "./operation-store.ts"
import { exclusiveNoFollowWriteFlags } from "./private-file.ts"
import { openSafeDownload } from "./safe-download.ts"
import {
  type RemoteTask,
  type RemoteTaskState,
  XiaoYunqueApi,
  XiaoYunqueAuthenticationError,
  XiaoYunqueRequestRejectedError,
  type XiaoYunqueRequestRejectionDiagnosticCode,
} from "./xiaoyunque-api.ts"

interface GenerationEngineOptions {
  api: XiaoYunqueApi
  authorizer: WebSessionAuthorizer
  fetch?: typeof fetch
  operationStore: OperationStore
  pollIntervalMs?: number
}

type GenerationInputErrorReason = "invalid-frame-combination" | "last-frame-without-first"

const generationInputErrorMessages: Record<GenerationInputErrorReason, string> = {
  "invalid-frame-combination":
    "Use either reference images, one first frame, or one first frame plus one last frame for XiaoYunque video generation.",
  "last-frame-without-first": "A video last frame requires exactly one first frame.",
}

export class XiaoYunqueGenerationInputError extends Error {
  override name = "XiaoYunqueGenerationInputError"
  readonly publicMessage: string

  constructor(reason: GenerationInputErrorReason) {
    const publicMessage = generationInputErrorMessages[reason]
    super(publicMessage)
    this.publicMessage = publicMessage
  }
}

export class XiaoYunqueObservationRejectedError extends Error {
  override name = "XiaoYunqueObservationRejectedError"
  readonly upstreamDiagnosticCode: XiaoYunqueRequestRejectionDiagnosticCode

  constructor(upstreamDiagnosticCode: XiaoYunqueRequestRejectionDiagnosticCode) {
    super("XiaoYunque generation status checks were rejected after submission")
    this.upstreamDiagnosticCode = upstreamDiagnosticCode
  }
}

export class XiaoYunqueUnsupportedImageModelError extends Error {
  override name = "XiaoYunqueUnsupportedImageModelError"

  constructor() {
    super("The selected XiaoYunque image model is unsupported")
  }
}

function abortError() {
  return new DOMException("Generation was cancelled", "AbortError")
}

async function abortableDelay(milliseconds: number, signal: AbortSignal) {
  if (signal.aborted) throw abortError()
  await new Promise<void>((resolve, reject) => {
    let settled = false
    const finish = (operation: () => void) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal.removeEventListener("abort", onAbort)
      operation()
    }
    const onAbort = () => finish(() => reject(abortError()))
    const timer = setTimeout(() => finish(resolve), milliseconds)
    signal.addEventListener("abort", onAbort, { once: true })
  })
}

function fileReferences(call: GenerationCall) {
  return call.references.filter((reference): reference is FileGenerationReference => reference.kind === "file")
}

function requireImageReferences(call: GenerationCall) {
  const references = fileReferences(call)
  if (call.references.some((reference) => reference.kind === "text")) {
    throw new Error("The XiaoYunque image tool does not accept Canvas text references")
  }
  if (references.some((reference) => reference.role !== "reference_image")) {
    throw new Error("The XiaoYunque image tool accepts only reference images")
  }
  if (references.length > 9) throw new Error("XiaoYunque accepts at most nine reference images")
  return references
}

function videoReferences(call: GenerationCall) {
  if (call.references.some((reference) => reference.kind === "text")) {
    throw new Error("The XiaoYunque video tool does not accept Canvas text references")
  }
  const files = fileReferences(call)
  const firstFrames = files.filter((reference) => reference.role === "first_frame")
  const lastFrames = files.filter((reference) => reference.role === "last_frame")
  const ordinaryImages = files.filter((reference) => reference.role === "reference_image")
  if (lastFrames.length > 0 && firstFrames.length === 0) {
    throw new XiaoYunqueGenerationInputError("last-frame-without-first")
  }
  if (
    firstFrames.length > 1
    || lastFrames.length > 1
    || firstFrames.length > 0 && ordinaryImages.length > 0
  ) {
    throw new XiaoYunqueGenerationInputError("invalid-frame-combination")
  }
  const usesFirstAndLastFrames = firstFrames.length === 1 && lastFrames.length === 1
  const images = usesFirstAndLastFrames
    ? [firstFrames[0]!, lastFrames[0]!]
    : firstFrames.length === 1
      ? [firstFrames[0]!]
      : ordinaryImages
  const videos = files.filter((reference) => reference.role === "reference_video")
  const audios = files.filter((reference) => reference.role === "audio")
  const knownCount = images.length + videos.length + audios.length
  if (knownCount !== files.length) throw new Error("The XiaoYunque video tool received an unsupported reference role")
  if (images.length > 9) throw new Error("XiaoYunque accepts at most nine reference images")
  if (videos.length > 3) throw new Error("XiaoYunque accepts at most three reference videos")
  if (audios.length > 3) throw new Error("XiaoYunque accepts at most three reference audio files")
  return { audios, generateType: usesFirstAndLastFrames ? 1 : undefined, images, videos }
}

function safeOperationStem(operationId: string) {
  const stem = operationId.toLowerCase().replaceAll(/[^a-z0-9_-]/g, "-").replaceAll(/-+/g, "-").slice(0, 32)
  return stem || "result"
}

interface MediaType {
  extension: string
  mimeType: string
}

function ascii(bytes: Uint8Array, start: number, end: number) {
  return new TextDecoder("ascii").decode(bytes.subarray(start, end))
}

function detectMedia(bytes: Uint8Array, output: GenerationOutput): MediaType {
  if (output === "image") {
    if (bytes.length >= 8 && bytes.subarray(0, 8).every((value, index) => value === [137, 80, 78, 71, 13, 10, 26, 10][index])) {
      return { extension: "png", mimeType: "image/png" }
    }
    if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
      return { extension: "jpg", mimeType: "image/jpeg" }
    }
    if (bytes.length >= 6 && (ascii(bytes, 0, 6) === "GIF87a" || ascii(bytes, 0, 6) === "GIF89a")) {
      return { extension: "gif", mimeType: "image/gif" }
    }
    if (bytes.length >= 12 && ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 12) === "WEBP") {
      return { extension: "webp", mimeType: "image/webp" }
    }
    if (bytes.length >= 2 && ascii(bytes, 0, 2) === "BM") return { extension: "bmp", mimeType: "image/bmp" }
    throw new Error("XiaoYunque returned an unrecognized image artifact")
  }
  if (bytes.length >= 12 && ascii(bytes, 4, 8) === "ftyp") return { extension: "mp4", mimeType: "video/mp4" }
  if (bytes.length >= 4 && bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3) {
    return { extension: "webm", mimeType: "video/webm" }
  }
  throw new Error("XiaoYunque returned an unrecognized video artifact")
}

export class GenerationEngine {
  readonly #api: XiaoYunqueApi
  readonly #authorizer: WebSessionAuthorizer
  readonly #fetch: typeof fetch
  readonly #operationStore: OperationStore
  readonly #pollIntervalMs: number

  constructor(options: GenerationEngineOptions) {
    this.#api = options.api
    this.#authorizer = options.authorizer
    this.#fetch = options.fetch ?? fetch
    this.#operationStore = options.operationStore
    this.#pollIntervalMs = options.pollIntervalMs ?? 10_000
  }

  async generate(
    call: GenerationCall,
    model: XiaoYunqueModel,
    signal: AbortSignal,
  ): Promise<GenerationArtifact[]> {
    if (!modelSupportsOutput(model, call.output)) {
      throw new Error("The selected XiaoYunque model does not match the generation output")
    }
    const outputDirectory = await this.#validateOutputDirectory(call.output_directory)
    const fingerprint = await fingerprintGenerationCall(call, model, signal)
    const task = await this.#operationStore.withOperationLock(call.operation_id, signal, async () => {
      const cached = await this.#operationStore.find(call.operation_id)
      if (cached) {
        if (cached.fingerprint !== fingerprint || cached.output !== call.output) {
          throw new Error("Generation operation id was reused with a different request")
        }
        if (cached.status === "submitting") {
          throw new Error("A prior XiaoYunque submission may have been accepted; refusing to submit it again")
        }
        return { runId: cached.runId, threadId: cached.threadId }
      }
      const createdAt = new Date().toISOString()
      const beforeSubmit = () => this.#operationStore.save(call.operation_id, {
        createdAt,
        fingerprint,
        output: call.output,
        status: "submitting",
      }, signal)
      const submitted = await this.#withSession(
        (session) => this.#submit(call, model, session, signal, beforeSubmit),
        signal,
      )
      await this.#operationStore.save(call.operation_id, {
        ...submitted,
        createdAt,
        fingerprint,
        output: call.output,
        status: "submitted",
      })
      return submitted
    })
    const result = await this.#poll(task, call.output, signal)
    const urls = call.output === "image" ? result.imageUrls : result.videoUrls
    if (urls.length === 0) {
      throw new Error(result.error || `XiaoYunque completed without a ${call.output} artifact`)
    }
    const artifacts: GenerationArtifact[] = []
    for (let index = 0; index < urls.length; index += 1) {
      artifacts.push(await this.#download(urls[index]!, call.output, outputDirectory, call.operation_id, index, signal))
    }
    return artifacts
  }

  async #submit(
    call: GenerationCall,
    model: XiaoYunqueModel,
    session: Awaited<ReturnType<WebSessionAuthorizer["session"]>>,
    signal: AbortSignal,
    beforeSubmit: () => Promise<void>,
  ) {
    if (call.output === "image") {
      const references = requireImageReferences(call)
      const assets = []
      for (const reference of references) assets.push(await this.#api.upload(reference, session, signal))
      if (signal.aborted) throw abortError()
      return this.#api.submitImage({
        assets,
        beforeSubmit,
        model: model as XiaoYunqueImageModel,
        prompt: call.prompt,
      }, session, signal)
    }
    const references = videoReferences(call)
    const uploadAll = async (values: FileGenerationReference[]) => {
      const result = []
      for (const reference of values) result.push(await this.#api.upload(reference, session, signal))
      return result
    }
    const imageAssets = await uploadAll(references.images)
    const videoAssets = await uploadAll(references.videos)
    const audioAssets = await uploadAll(references.audios)
    if (signal.aborted) throw abortError()
    return this.#api.submitVideo({
      audioAssets,
      beforeSubmit,
      ...(references.generateType === undefined ? {} : { generateType: references.generateType }),
      imageAssets,
      model: model as XiaoYunqueVideoModel,
      prompt: call.prompt,
      videoAssets,
    }, session, signal)
  }

  async #poll(task: RemoteTask, output: GenerationOutput, signal: AbortSignal) {
    let consecutiveFailures = 0
    while (true) {
      if (signal.aborted) throw abortError()
      let result: RemoteTaskState
      try {
        result = await this.#withSession(
          (session) => this.#api.query(task, output, session, signal),
          signal,
        )
      } catch (error) {
        if (signal.aborted) throw error
        if (error instanceof XiaoYunqueAuthenticationError) throw error
        if (++consecutiveFailures >= 3) {
          // Polling starts only after the accepted task identity has been saved.
          // Do not reuse a submit-stage rejection here: its public guidance would
          // incorrectly imply that this paid task was never accepted.
          if (error instanceof XiaoYunqueRequestRejectedError) {
            throw new XiaoYunqueObservationRejectedError(error.diagnosticCode)
          }
          throw error
        }
        await abortableDelay(this.#pollIntervalMs, signal)
        continue
      }
      consecutiveFailures = 0
      if (result.state === 3) return result
      if (result.state === 4 || result.state === 5) {
        if (result.terminalDiagnosticCode === "unsupported-image-model") {
          throw new XiaoYunqueUnsupportedImageModelError()
        }
        throw new Error(result.error || `XiaoYunque ${output} generation failed`)
      }
      if (result.state === 6) {
        throw new Error(`XiaoYunque ${output} generation requires additional input`)
      }
      if (result.state === 9) {
        throw new Error(result.error || `XiaoYunque ${output} generation was interrupted for human input`)
      }
      await abortableDelay(this.#pollIntervalMs, signal)
    }
  }

  async #withSession<T>(
    operation: (session: Awaited<ReturnType<WebSessionAuthorizer["session"]>>) => Promise<T>,
    signal: AbortSignal,
  ) {
    const session = await this.#authorizer.session(signal)
    return operation(session)
  }

  async #validateOutputDirectory(directory: string) {
    if (!path.isAbsolute(directory)) throw new Error("Generation output_directory must be absolute")
    const info = await lstat(directory)
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Generation output_directory is not a real directory")
    return directory
  }

  async #download(
    rawUrl: string,
    output: GenerationOutput,
    outputDirectory: string,
    operationId: string,
    index: number,
    signal: AbortSignal,
  ) {
    const response = await openSafeDownload(rawUrl, {
      allowLoopbackTest: this.#api.allowsInsecureArtifactDownloads,
      fetch: this.#fetch,
      signal,
    })
    const limit = output === "image" ? 100 * 1024 * 1024 : 512 * 1024 * 1024
    if (response.contentLength !== null && response.contentLength > limit) {
      throw new Error("XiaoYunque artifact is too large")
    }
    const temporaryPath = path.join(outputDirectory, `.xiaoyunque-${crypto.randomUUID()}.download`)
    let temporary: Awaited<ReturnType<typeof open>> | undefined
    let total = 0
    const prefix: number[] = []
    try {
      temporary = await open(temporaryPath, exclusiveNoFollowWriteFlags(), 0o600)
      await temporary.chmod(0o600)
      const temporaryInfo = await temporary.stat()
      if (!temporaryInfo.isFile() || (temporaryInfo.mode & 0o777) !== 0o600) {
        throw new Error("XiaoYunque artifact staging file is not private")
      }
      for await (const value of response.stream) {
        total += value.byteLength
        if (total > limit) throw new Error("XiaoYunque artifact is too large")
        for (const byte of value.subarray(0, Math.max(0, 512 - prefix.length))) prefix.push(byte)
        let offset = 0
        while (offset < value.byteLength) {
          const { bytesWritten } = await temporary.write(value, offset, value.byteLength - offset)
          if (bytesWritten <= 0) throw new Error("Unable to stage XiaoYunque artifact")
          offset += bytesWritten
        }
      }
      if (total === 0) throw new Error("XiaoYunque returned an empty artifact")
      const media = detectMedia(Uint8Array.from(prefix), output)
      const name = `xiaoyunque-${safeOperationStem(operationId)}-${index + 1}.${media.extension}`
      const finalPath = path.join(outputDirectory, name)
      await temporary.sync()
      await temporary.close()
      temporary = undefined
      await rename(temporaryPath, finalPath)
      const committedInfo = await lstat(finalPath)
      if (
        !committedInfo.isFile()
        || committedInfo.isSymbolicLink()
        || (committedInfo.mode & 0o777) !== 0o600
      ) {
        throw new Error("XiaoYunque artifact staging file is not private")
      }
      return { mimeType: media.mimeType, name, path: name }
    } finally {
      await temporary?.close().catch(() => undefined)
      await rm(temporaryPath, { force: true })
    }
  }
}
