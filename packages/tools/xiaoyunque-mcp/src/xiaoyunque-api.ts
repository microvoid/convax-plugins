import { randomUUID } from "node:crypto"
import { lstat } from "node:fs/promises"
import type { FileGenerationReference, GenerationOutput } from "./contracts.ts"
import type { XiaoYunqueImageModel, XiaoYunqueVideoModel } from "./models.ts"
import {
  type StoredWebSession,
  webSessionCookieHeader,
  xiaoYunqueCookieOrigin,
} from "./web-session-store.ts"

const odinUserInfoPath = "/api/biz/v1/common/get_odin_user_info"
const userWorkspacePath = "/api/web/v1/workspace/get_user_workspace"
const uploadPath = "/api/web/v1/common/upload_file"
const assetCreateV2Path = "/api/biz/v1/asset/create_v2"
const submitPath = "/api/biz/v1/agent/submit_run"
const getThreadPath = "/api/biz/v1/agent/get_thread"

const maximumJsonResponseBytes = 2 * 1024 * 1024
const maximumArtifactCount = 16
const maximumEntryCount = 512
const maximumContentCount = 512
const defaultQueryRequestTimeoutMs = 30_000

export class XiaoYunqueAuthenticationError extends Error {
  override name = "XiaoYunqueAuthenticationError"
}

export class XiaoYunqueQueryTimeoutError extends Error {
  override name = "XiaoYunqueQueryTimeoutError"
}

/**
 * The first-party upload succeeded, but its EverPhoto asset could not be
 * registered as the Pippit asset identity required by image and video generation.
 * Never attach upstream response details to this error because it crosses the
 * MCP diagnostic boundary.
 */
export class XiaoYunqueReferenceAssetRegistrationError extends Error {
  override name = "XiaoYunqueReferenceAssetRegistrationError"
  readonly referenceType: "image" | "video"

  constructor(referenceType: "image" | "video" = "image") {
    super(`XiaoYunque reference ${referenceType} asset registration failed`)
    this.referenceType = referenceType
  }
}

/**
 * The first-party Web API returned a non-success status or envelope. Keep the
 * raw response inside the API boundary while still letting the MCP surface
 * distinguish an upstream rejection from local validation and transport
 * failures.
 */
export class XiaoYunqueRequestRejectedError extends Error {
  override name = "XiaoYunqueRequestRejectedError"
  readonly diagnosticCode: XiaoYunqueRequestRejectionDiagnosticCode

  constructor(
    message: string,
    diagnosticCode: XiaoYunqueRequestRejectionDiagnosticCode = "upstream-request-rejected",
  ) {
    super(message)
    this.diagnosticCode = diagnosticCode
  }
}

export type XiaoYunqueRequestRejectionDiagnosticCode =
  | "upstream-envelope-rejected"
  | "upstream-http-rejected"
  | "upstream-request-rejected"

export interface XiaoYunqueApiOptions {
  queryRequestTimeoutMs?: number
}

export interface RemoteTask {
  runId: string
  threadId: string
}

export interface RemoteTaskState extends RemoteTask {
  error?: string
  imageUrls: string[]
  state: number
  terminalDiagnosticCode?: XiaoYunqueTerminalDiagnosticCode
  videoUrls: string[]
}

export type XiaoYunqueTerminalDiagnosticCode = "unsupported-image-model"

export interface UploadedAssetMetadata {
  durationMilliseconds?: number
  format?: string
  frameCount?: number
  height?: number
  md5?: string
  mime?: string
  ratio?: string
  size?: number
  width?: number
}

export interface UploadedAsset {
  assetId: string
  metadata: UploadedAssetMetadata
  name: string
  pippitAssetId?: string
  url: string
}

export interface ImageSubmitOptions {
  assets: UploadedAsset[]
  beforeSubmit?: () => Promise<void>
  model: XiaoYunqueImageModel
  prompt: string
  ratio?: string
  resolution?: string
}

export interface VideoSubmitOptions {
  audioAssets: UploadedAsset[]
  beforeSubmit?: () => Promise<void>
  durationSeconds?: number
  generateType?: number
  imageAssets: UploadedAsset[]
  language?: string
  model: XiaoYunqueVideoModel
  prompt: string
  ratio?: string
  resolution?: string
  videoAssets: UploadedAsset[]
}

interface XiaoYunqueUserInfo {
  consumer_uid: string
  space_id?: string
  workspace_id: string
}

type FetchLike = typeof fetch
type UploadAssetType = 1 | 2 | 4
type RegisteredAssetType = 1 | 2

function record(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function cancellationError(signal: AbortSignal) {
  return signal.reason instanceof Error
    ? signal.reason
    : new DOMException("Generation was cancelled", "AbortError")
}

function boundedString(value: unknown, label: string, maximumBytes = 4_096) {
  if (
    typeof value !== "string"
    || value.length === 0
    || value !== value.trim()
    || Buffer.byteLength(value, "utf8") > maximumBytes
    || /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw new Error(`${label} is invalid`)
  }
  return value
}

function optionalBoundedString(value: unknown, label: string, maximumBytes = 4_096) {
  if (value === undefined || value === null || value === "") return undefined
  return boundedString(value, label, maximumBytes)
}

function optionalPippitAssetId(value: unknown) {
  if (value === undefined || value === null) return undefined
  if (typeof value !== "string") {
    return boundedString(value, "XiaoYunque uploaded Pippit asset id", 1_024)
  }
  const candidate = value.trim()
  if (candidate.length === 0) return undefined
  return boundedString(candidate, "XiaoYunque uploaded Pippit asset id", 1_024)
}

function nonNegativeInteger(value: unknown, label: string) {
  const number = typeof value === "string" && /^(?:0|[1-9]\d*)$/u.test(value)
    ? Number(value)
    : value
  if (typeof number !== "number" || !Number.isSafeInteger(number) || number < 0) {
    throw new Error(`${label} is invalid`)
  }
  return number
}

function optionalNonNegativeInteger(value: unknown, label: string) {
  if (value === undefined || value === null || value === "") return undefined
  return nonNegativeInteger(value, label)
}

function strictUrl(value: unknown, label: string, allowLoopbackHttp: boolean) {
  const candidate = boundedString(value, label, 16_384)
  let url: URL
  try {
    url = new URL(candidate)
  } catch {
    throw new Error(`${label} is invalid`)
  }
  const isAllowedLoopback = allowLoopbackHttp
    && url.protocol === "http:"
    && url.hostname === "127.0.0.1"
  if (
    (url.protocol !== "https:" && !isAllowedLoopback)
    || url.username
    || url.password
    || !url.hostname
    || url.hash
  ) {
    throw new Error(`${label} is invalid`)
  }
  return candidate
}

function looksLikeAuthenticationFailure(value: Record<string, unknown>, status: number) {
  return status === 401 || String(value.ret ?? "") === "1015"
}

function requireSuccess(value: unknown, status: number, label: string) {
  const envelope = record(value)
  if (!envelope) throw new Error(`${label} returned an invalid response`)
  if (looksLikeAuthenticationFailure(envelope, status)) {
    throw new XiaoYunqueAuthenticationError("XiaoYunque authorization is no longer valid")
  }
  if (status < 200 || status >= 300) {
    throw new XiaoYunqueRequestRejectedError(`${label} was rejected`, "upstream-http-rejected")
  }
  if (envelope.ret !== 0 && envelope.ret !== "0") {
    throw new XiaoYunqueRequestRejectedError(`${label} was rejected`, "upstream-envelope-rejected")
  }
  return envelope
}

function requireAssetRegistrationSuccess(value: unknown, status: number) {
  const label = "XiaoYunque reference image asset registration"
  const envelope = record(value)
  if (!envelope) throw new Error(`${label} returned an invalid response`)
  if (looksLikeAuthenticationFailure(envelope, status)) {
    throw new XiaoYunqueAuthenticationError("XiaoYunque authorization is no longer valid")
  }
  if (status < 200 || status >= 300) {
    throw new XiaoYunqueRequestRejectedError(`${label} was rejected`, "upstream-http-rejected")
  }
  // Unlike generation envelopes, the first-party AssetCreateV2 contract may
  // omit `ret`; an explicit value must still be the canonical numeric zero.
  if (envelope.ret !== undefined && envelope.ret !== 0 && envelope.ret !== "0") {
    throw new XiaoYunqueRequestRejectedError(`${label} was rejected`, "upstream-envelope-rejected")
  }
  return envelope
}

async function boundedJson(response: Response, label: string) {
  if (response.status === 401) {
    await response.body?.cancel().catch(() => undefined)
    throw new XiaoYunqueAuthenticationError("XiaoYunque authorization is no longer valid")
  }
  const declaredLength = response.headers.get("content-length")
  if (declaredLength !== null) {
    const parsed = Number(declaredLength)
    if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > maximumJsonResponseBytes) {
      await response.body?.cancel().catch(() => undefined)
      throw new Error(`${label} returned an invalid response`)
    }
  }
  if (!response.body) throw new Error(`${label} returned an invalid response`)
  const chunks: Uint8Array[] = []
  let total = 0
  const reader = response.body.getReader()
  try {
    while (true) {
      const next = await reader.read()
      if (next.done) break
      total += next.value.byteLength
      if (total > maximumJsonResponseBytes) {
        await reader.cancel().catch(() => undefined)
        throw new Error(`${label} returned an invalid response`)
      }
      chunks.push(next.value)
    }
  } finally {
    reader.releaseLock()
  }
  if (total === 0) throw new Error(`${label} returned an invalid response`)
  const bytes = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  let text: string
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes)
  } catch {
    throw new Error(`${label} returned an invalid response`)
  }
  try {
    return JSON.parse(text) as unknown
  } catch {
    throw new Error(`${label} returned an invalid response`)
  }
}

function uploadAssetType(reference: FileGenerationReference): UploadAssetType {
  if (reference.role === "reference_video" || reference.mime_type.startsWith("video/")) return 1
  if (reference.role === "audio" || reference.mime_type.startsWith("audio/")) return 4
  if (
    reference.role === "reference_image"
    || reference.role === "first_frame"
    || reference.role === "last_frame"
    || reference.mime_type.startsWith("image/")
  ) return 2
  throw new Error("XiaoYunque does not support this reference type")
}

function registeredAssetTypeForUpload(assetType: UploadAssetType): RegisteredAssetType | undefined {
  switch (assetType) {
    case 1: // video
      return 2
    case 2: // image
      return 1
    case 4: // audio does not require AssetCreateV2 registration
      return undefined
  }
}

function uploadedAsset(
  value: unknown,
  reference: FileGenerationReference,
  assetType: UploadAssetType,
  allowLoopbackHttp: boolean,
): UploadedAsset {
  const data = record(value)
  if (!data) throw new Error("XiaoYunque reference upload returned an invalid asset")
  const assetId = boundedString(data.asset_id, "XiaoYunque uploaded asset id", 1_024)
  const url = strictUrl(data.download_url, "XiaoYunque uploaded asset URL", allowLoopbackHttp)
  const width = optionalNonNegativeInteger(data.width, "XiaoYunque uploaded asset width")
  const height = optionalNonNegativeInteger(data.height, "XiaoYunque uploaded asset height")
  const durationMilliseconds = optionalNonNegativeInteger(
    data.duration_ms,
    "XiaoYunque uploaded asset duration",
  )
  const size = optionalNonNegativeInteger(data.size, "XiaoYunque uploaded asset size")
  const format = optionalBoundedString(data.format, "XiaoYunque uploaded asset format", 128)
  const md5 = optionalBoundedString(data.md5, "XiaoYunque uploaded asset md5", 256)
  const mime = optionalBoundedString(data.mime, "XiaoYunque uploaded asset MIME type", 256)
  const pippitAssetId = optionalPippitAssetId(data.pippit_asset_id)
  const ratio = width && height ? `${width}:${height}` : undefined
  return {
    assetId,
    metadata: {
      ...(durationMilliseconds === undefined ? {} : { durationMilliseconds }),
      ...(format === undefined ? {} : { format }),
      ...(assetType === 2 ? { frameCount: 1 } : {}),
      ...(height === undefined ? {} : { height }),
      ...(md5 === undefined ? {} : { md5 }),
      ...(mime === undefined ? {} : { mime }),
      ...(ratio === undefined ? {} : { ratio }),
      ...(size === undefined ? {} : { size }),
      ...(width === undefined ? {} : { width }),
    },
    name: boundedString(reference.name, "XiaoYunque uploaded asset name", 1_024),
    ...(pippitAssetId === undefined ? {} : { pippitAssetId }),
    url,
  }
}

function requestAsset(asset: UploadedAsset) {
  const metadata = {
    ...(asset.metadata.width === undefined ? {} : { width: asset.metadata.width }),
    ...(asset.metadata.height === undefined ? {} : { height: asset.metadata.height }),
    ...(asset.metadata.format === undefined ? {} : { format: asset.metadata.format }),
    ...(asset.metadata.md5 === undefined ? {} : { md5: asset.metadata.md5 }),
    ...(asset.metadata.frameCount === undefined ? {} : { frame_cnt: asset.metadata.frameCount }),
    ...(asset.metadata.durationMilliseconds === undefined
      ? {}
      : { duration_ms: asset.metadata.durationMilliseconds }),
    ...(asset.metadata.size === undefined ? {} : { size: asset.metadata.size }),
    ...(asset.metadata.ratio === undefined ? {} : { ratio: asset.metadata.ratio }),
    ...(asset.metadata.mime === undefined ? {} : { mime: asset.metadata.mime }),
    name: asset.name,
  }
  return {
    asset_id: asset.assetId,
    ...(asset.pippitAssetId === undefined ? {} : { pippit_asset_id: asset.pippitAssetId }),
    metadata,
    name: asset.name,
    url: asset.url,
  }
}

function videoModelAcceptsResolution(model: XiaoYunqueVideoModel) {
  // The current first-party immersive-video client deliberately omits the
  // resolution field for both Mini variants. Sending its UI default (720p)
  // changes the request contract and XiaoYunque rejects the submission.
  return model !== "Seedance_2.0_mini" && model !== "Seedance_2.0_mini_lite"
}

function videoModelSupportsVideoReferences(model: XiaoYunqueVideoModel) {
  return model !== "Seedance_1.0_fast"
}

function videoModelSupportsAudioReferences(model: XiaoYunqueVideoModel) {
  return model !== "Seedance_1.0_fast"
}

function videoModelSupportsFirstAndLastFrames(model: XiaoYunqueVideoModel) {
  return model !== "Seedance_1.0_fast"
}

function clientOperatingSystem() {
  if (process.platform === "darwin") return "mac"
  if (process.platform === "win32") return "windows"
  if (process.platform === "linux") return "linux"
  return undefined
}

function runContext(
  task: RemoteTask,
  agentName: string,
  editType: "image_generation" | "video_part",
  entranceFrom: "home" | "web",
  options: {
    includeOperatingSystem?: boolean
    position?: "canvas" | "home"
    runSource?: string
    tabName?: "canvas" | "other"
    target?: GenerationOutput
  } = {},
) {
  const tabName = options.tabName ?? "other"
  const osName = options.includeOperatingSystem === false ? undefined : clientOperatingSystem()
  const clientExtra = {
    edit_type: editType,
    ...(options.position === undefined ? {} : { position: options.position }),
    entrance_from: entranceFrom,
    tab_name: tabName,
    ...(options.target === undefined ? {} : { target: options.target }),
    ...(options.runSource === undefined ? {} : { run_source: options.runSource }),
    ...(osName === undefined ? {} : { os_name: osName }),
  }
  const babiParam = {
    generate_id: task.runId,
    section_id: task.runId,
    scene_lv1: "ai_agent",
    scene_lv2: "front_tool",
    tool_id: agentName,
    tab_name: tabName,
    edit_type: editType,
    enter_from: entranceFrom,
  }
  const { generate_id: _generateId, ...queryBabiParam } = babiParam
  return {
    body: JSON.stringify({ client_extra: clientExtra, babi_param: babiParam }),
    // XiaoYunque's current Web request interceptor mirrors babi_param into the
    // submit_run query after removing only generate_id. Keep that first-party
    // routing context aligned instead of relying on the backend to recover it
    // from run_extra alone.
    query: JSON.stringify(queryBabiParam),
  }
}

function strictRunState(value: unknown) {
  if (typeof value === "string" && /^(?:0|[1-9])$/u.test(value)) return Number(value)
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= 9) return value
  throw new Error("XiaoYunque generation state is invalid")
}

function failureReason(value: unknown) {
  if (value === undefined || value === null) return ""
  const reason = record(value)
  if (!reason) throw new Error("XiaoYunque generation failure reason is invalid")
  for (const candidate of [reason.message, reason.fallback_message, reason.detail, reason.error_cta_message]) {
    if (candidate === undefined || candidate === null || candidate === "") continue
    return boundedString(candidate, "XiaoYunque generation failure reason", 2_000)
  }
  return ""
}

function terminalDiagnosticCode(
  output: GenerationOutput,
  state: number,
  failure: string,
): XiaoYunqueTerminalDiagnosticCode | undefined {
  // This is an exact allowlist, not a general vendor-message parser. The value
  // was observed from live get_thread after web_model_config v5 advertised
  // Nova 2 but the raw image_generation submit surface rejected its model name.
  // Never carry arbitrary fail_reason text into the public MCP result.
  return output === "image"
    && state === 4
    && failure === "unsupported image_model_name: nova2"
    ? "unsupported-image-model"
    : undefined
}

function contentData(value: unknown) {
  if (typeof value === "string") {
    if (Buffer.byteLength(value, "utf8") > 256 * 1024) {
      throw new Error("XiaoYunque generation artifact is invalid")
    }
    try {
      return record(JSON.parse(value) as unknown)
    } catch {
      throw new Error("XiaoYunque generation artifact is invalid")
    }
  }
  return record(value)
}

function artifactUrl(value: unknown) {
  const media = record(value)
  const sceneUrls = record(media?.scene_urls)
  if (typeof sceneUrls?.download === "string" && sceneUrls.download.trim()) return sceneUrls.download
  return media?.url
    ?? media?.previewUrl
    ?? media?.preview_url
    ?? media?.downloadUrl
    ?? media?.download_url
}

function artifactUrls(
  entriesValue: unknown,
  allowLoopbackHttp: boolean,
  allowIncompleteMedia: boolean,
) {
  if (entriesValue === undefined || entriesValue === null) {
    return { imageUrls: [], videoUrls: [] }
  }
  if (!Array.isArray(entriesValue) || entriesValue.length > maximumEntryCount) {
    throw new Error("XiaoYunque generation entries are invalid")
  }
  const imageUrls: string[] = []
  const videoUrls: string[] = []
  for (const entryValue of entriesValue) {
    const entry = record(entryValue)
    if (!entry) throw new Error("XiaoYunque generation entry is invalid")
    const container = entry.type === 1 || entry.type === "1"
      ? record(entry.message)
      : entry.type === 2 || entry.type === "2"
        ? record(entry.artifact)
        : undefined
    if (!container) continue
    if (!Array.isArray(container.content) || container.content.length > maximumContentCount) {
      throw new Error("XiaoYunque generation content is invalid")
    }
    for (const partValue of container.content) {
      const part = record(partValue)
      if (!part) throw new Error("XiaoYunque generation content is invalid")
      if (part.sub_type !== "biz/x_data_image" && part.sub_type !== "biz/x_data_video") continue
      const data = contentData(part.data)
      if (!data) throw new Error("XiaoYunque generation artifact is invalid")
      const media = part.sub_type === "biz/x_data_image" ? data?.image : data?.video
      if (media !== undefined && media !== null && !record(media)) {
        throw new Error("XiaoYunque generation artifact is invalid")
      }
      const rawUrl = artifactUrl(media)
      // Running entries may publish their final media-shaped content block before
      // the artifact URL is ready. Keep validating the surrounding bounded
      // structure, and continue rejecting any URL that is present but unsafe.
      // Completion remains strict: every recognized media block must carry a
      // valid artifact URL, and the requested output must be present below.
      if (allowIncompleteMedia && (rawUrl === undefined || rawUrl === null || rawUrl === "")) continue
      const url = strictUrl(
        rawUrl,
        `XiaoYunque ${part.sub_type === "biz/x_data_image" ? "image" : "video"} artifact URL`,
        allowLoopbackHttp,
      )
      const target = part.sub_type === "biz/x_data_image" ? imageUrls : videoUrls
      if (!target.includes(url)) target.push(url)
      if (target.length > maximumArtifactCount) {
        throw new Error("XiaoYunque generation returned too many artifacts")
      }
    }
  }
  return { imageUrls, videoUrls }
}

export class XiaoYunqueApi {
  readonly #allowLoopbackTest: boolean
  readonly #baseUrl: URL
  readonly #fetch: FetchLike
  readonly #queryRequestTimeoutMs: number

  constructor(
    baseUrl: string = xiaoYunqueCookieOrigin,
    fetchLike: FetchLike = fetch,
    options: XiaoYunqueApiOptions = {},
  ) {
    this.#baseUrl = new URL(baseUrl)
    this.#allowLoopbackTest = this.#baseUrl.protocol === "http:" && this.#baseUrl.hostname === "127.0.0.1"
    if (this.#baseUrl.origin !== xiaoYunqueCookieOrigin && !this.#allowLoopbackTest) {
      throw new Error("XiaoYunque API origin is invalid")
    }
    this.#fetch = fetchLike
    this.#queryRequestTimeoutMs = options.queryRequestTimeoutMs ?? defaultQueryRequestTimeoutMs
    if (
      !Number.isSafeInteger(this.#queryRequestTimeoutMs)
      || this.#queryRequestTimeoutMs <= 0
      || this.#queryRequestTimeoutMs > 5 * 60_000
    ) {
      throw new Error("XiaoYunque query request timeout is invalid")
    }
  }

  get allowsInsecureArtifactDownloads() {
    return this.#allowLoopbackTest
  }

  async upload(
    reference: FileGenerationReference,
    session: StoredWebSession,
    signal: AbortSignal,
  ): Promise<UploadedAsset> {
    const info = await lstat(reference.path)
    if (!info.isFile() || info.isSymbolicLink()) throw new Error("Generation reference is not a regular file")
    if (info.size > 200 * 1024 * 1024) throw new Error("XiaoYunque references cannot exceed 200 MiB")
    const assetType = uploadAssetType(reference)
    const body = new FormData()
    // Wrapping the path-backed Blob gives multipart an explicit public file name;
    // Bun otherwise serializes the native absolute path as the filename.
    body.append("file", new File(
      [Bun.file(reference.path, { type: reference.mime_type })],
      reference.name,
      { type: reference.mime_type },
    ))
    body.append("asset_type", String(assetType))
    const response = await this.#request(uploadPath, session, signal, { body, method: "POST" })
    const payload = requireSuccess(response.value, response.status, "XiaoYunque reference upload")
    const asset = uploadedAsset(payload.data, reference, assetType, this.#allowLoopbackTest)
    const registeredAssetType = registeredAssetTypeForUpload(assetType)
    if (registeredAssetType === undefined || asset.pippitAssetId !== undefined) return asset

    return {
      ...asset,
      pippitAssetId: await this.#registerUploadedAsset(
        asset.assetId,
        registeredAssetType,
        session,
        signal,
      ),
    }
  }

  async #registerUploadedAsset(
    assetId: string,
    assetType: RegisteredAssetType,
    session: StoredWebSession,
    signal: AbortSignal,
  ) {
    try {
      // `upload_file.asset_id` is an EverPhoto source id. The first-party Web
      // product converts it into the identity consumed by image and video generation via
      // AssetCreateV2; the two ids are deliberately never treated as aliases. The
      // upload_file and AssetCreateV2 asset-type enums differ: upload 2/1 maps to
      // registered image/video 1/2 respectively.
      const response = await this.#jsonRequest(assetCreateV2Path, {
        asset_source_type: 3,
        asset_source_id: assetId,
        asset_type: assetType,
        Base: { Client: "web" },
      }, session, signal)
      const payload = requireAssetRegistrationSuccess(response.value, response.status)
      const data = record(payload.data)
      return boundedString(
        data?.PippitAssetID,
        "XiaoYunque registered Pippit asset id",
        1_024,
      )
    } catch (error) {
      if (signal.aborted) throw cancellationError(signal)
      if (error instanceof XiaoYunqueAuthenticationError) throw error
      throw new XiaoYunqueReferenceAssetRegistrationError(assetType === 1 ? "image" : "video")
    }
  }

  async submitImage(
    options: ImageSubmitOptions,
    session: StoredWebSession,
    signal: AbortSignal,
  ): Promise<RemoteTask> {
    const prompt = boundedString(options.prompt.trim(), "XiaoYunque image prompt", 32_768)
    if (options.assets.length > 9) throw new Error("XiaoYunque accepts at most nine reference images")
    const task = { runId: randomUUID(), threadId: randomUUID() }
    const agentName = "pippit_novel_agent_cn_v2"
    // Convax references are uploaded files, so the first-party Canvas builder
    // represents them as Pippit asset ids. `node_asset_refs` is reserved for
    // references that already belong to a XiaoYunque Canvas node; the Plugin
    // must not invent that native node identity for a Convax file asset.
    const pippitAssetIds = [...new Set(options.assets.map((asset) => boundedString(
      asset.pippitAssetId,
      "XiaoYunque uploaded Pippit asset id",
      1_024,
    )))]
    const content = [{
      type: "data",
      sub_type: "biz/x_data_novel_raw_image_gen",
      data: JSON.stringify({
        prompt,
        args: {},
        pippit_asset_ids: pippitAssetIds,
        image_count: 1,
        model: options.model,
        ratio: options.ratio ?? "1:1",
        image_resolution: (options.resolution ?? "2k").toUpperCase(),
      }),
    }]
    await this.#submit({
      agentName,
      ...(options.beforeSubmit === undefined ? {} : { beforeSubmit: options.beforeSubmit }),
      content,
      editType: "image_generation",
      entranceFrom: "web",
      includeSpaceId: true,
      position: "canvas",
      runSource: "image-generation-submit",
      tabName: "canvas",
      target: "image",
      task,
    }, session, signal)
    return task
  }

  async submitVideo(
    options: VideoSubmitOptions,
    session: StoredWebSession,
    signal: AbortSignal,
  ): Promise<RemoteTask> {
    const prompt = boundedString(options.prompt.trim(), "XiaoYunque video prompt", 32_768)
    const maximumImages = options.model === "Seedance_1.0_fast" ? 1 : 9
    if (options.imageAssets.length > maximumImages) {
      throw new Error(`XiaoYunque ${options.model} accepts at most ${maximumImages} reference image${maximumImages === 1 ? "" : "s"}`)
    }
    if (options.videoAssets.length > 3) throw new Error("XiaoYunque accepts at most three reference videos")
    if (options.audioAssets.length > 3) throw new Error("XiaoYunque accepts at most three reference audio files")
    if (!videoModelSupportsVideoReferences(options.model) && options.videoAssets.length > 0) {
      throw new Error(`XiaoYunque ${options.model} does not accept reference videos`)
    }
    if (!videoModelSupportsAudioReferences(options.model) && options.audioAssets.length > 0) {
      throw new Error(`XiaoYunque ${options.model} does not accept reference audio`)
    }
    if (!videoModelSupportsFirstAndLastFrames(options.model) && options.generateType !== undefined) {
      throw new Error(`XiaoYunque ${options.model} does not accept first and last frames`)
    }
    const durationSeconds = options.durationSeconds ?? 5
    if (!Number.isSafeInteger(durationSeconds) || durationSeconds < 1 || durationSeconds > 60) {
      throw new Error("XiaoYunque video duration is invalid")
    }
    const task = { runId: randomUUID(), threadId: randomUUID() }
    const agentName = "pippit_novel_video_part_agent"
    const toolParam = {
      prompt,
      images: options.imageAssets.map(requestAsset),
      duration_sec: durationSeconds,
      language: options.language ?? "zh",
      ratio: options.ratio ?? "16:9",
      ...(videoModelAcceptsResolution(options.model)
        ? { resolution: options.resolution ?? "720p" }
        : {}),
      ...(videoModelSupportsVideoReferences(options.model)
        ? { videos: options.videoAssets.map(requestAsset) }
        : {}),
      ...(videoModelSupportsAudioReferences(options.model)
        ? { audios: options.audioAssets.map(requestAsset) }
        : {}),
      model: options.model,
      ...(options.generateType === undefined || !videoModelSupportsFirstAndLastFrames(options.model)
        ? {}
        : { generate_type: options.generateType }),
    }
    await this.#submit({
      agentName,
      ...(options.beforeSubmit === undefined ? {} : { beforeSubmit: options.beforeSubmit }),
      content: [{
        type: "data",
        sub_type: "biz/x_data_direct_tool_call_req",
        data: JSON.stringify({
          tool_name: "biz/x_tool_name_video_part",
          param: JSON.stringify(toolParam),
        }),
        hidden: false,
        is_thought: false,
      }],
      editType: "video_part",
      entranceFrom: "web",
      includeOperatingSystem: false,
      includeSpaceId: true,
      position: "canvas",
      runSource: "video_part",
      tabName: "canvas",
      target: "video",
      task,
    }, session, signal)
    return task
  }

  async query(
    task: RemoteTask,
    output: GenerationOutput,
    session: StoredWebSession,
    signal: AbortSignal,
  ): Promise<RemoteTaskState> {
    return this.#withQueryRequestTimeout(signal, async (requestSignal) => {
      const run = await this.#queryRun(task, session, requestSignal)
      const state = strictRunState(run.state)
      const urls = artifactUrls(run.entry_list, this.#allowLoopbackTest, state !== 3)
      const failure = failureReason(run.fail_reason)
      const diagnosticCode = terminalDiagnosticCode(output, state, failure)
      const expectedUrls = output === "image" ? urls.imageUrls : urls.videoUrls
      const defaultFailure = state === 4
        ? `XiaoYunque ${output} generation failed`
        : state === 5
          ? `XiaoYunque ${output} generation was cancelled`
          : state === 9
            ? `XiaoYunque ${output} generation was interrupted for human input`
            : state === 3 && expectedUrls.length === 0
              ? `XiaoYunque returned no ${output} artifact`
              : ""
      return {
        ...task,
        ...((failure || defaultFailure) ? { error: failure || defaultFailure } : {}),
        ...(diagnosticCode ? { terminalDiagnosticCode: diagnosticCode } : {}),
        ...urls,
        state,
      }
    })
  }

  async #withQueryRequestTimeout<T>(
    signal: AbortSignal,
    operation: (requestSignal: AbortSignal) => Promise<T>,
  ) {
    if (signal.aborted) throw cancellationError(signal)
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    let onAbort: (() => void) | undefined
    const interruption = new Promise<never>((_resolve, reject) => {
      onAbort = () => {
        controller.abort(signal.reason)
        reject(cancellationError(signal))
      }
      signal.addEventListener("abort", onAbort, { once: true })
      timer = setTimeout(() => {
        controller.abort()
        reject(new XiaoYunqueQueryTimeoutError("XiaoYunque generation status request timed out"))
      }, this.#queryRequestTimeoutMs)
    })
    try {
      return await Promise.race([operation(controller.signal), interruption])
    } finally {
      if (timer) clearTimeout(timer)
      if (onAbort) signal.removeEventListener("abort", onAbort)
    }
  }

  async #submit(
    options: {
      agentName: string
      beforeSubmit?: () => Promise<void>
      content: Record<string, unknown>[]
      editType: "image_generation" | "video_part"
      entranceFrom: "home" | "web"
      includeOperatingSystem?: boolean
      includeSpaceId: boolean
      position?: "canvas" | "home"
      runSource?: string
      tabName?: "canvas" | "other"
      target?: GenerationOutput
      task: RemoteTask
    },
    session: StoredWebSession,
    signal: AbortSignal,
  ) {
    const userInfo = await this.#userInfo(session, signal)
    const context = runContext(
      options.task,
      options.agentName,
      options.editType,
      options.entranceFrom,
      {
        ...(options.position === undefined ? {} : { position: options.position }),
        ...(options.includeOperatingSystem === undefined
          ? {}
          : { includeOperatingSystem: options.includeOperatingSystem }),
        ...(options.runSource === undefined ? {} : { runSource: options.runSource }),
        ...(options.tabName === undefined ? {} : { tabName: options.tabName }),
        ...(options.target === undefined ? {} : { target: options.target }),
      },
    )
    const body = {
      message: {
        message_id: "",
        role: "user",
        thread_id: options.task.threadId,
        run_id: options.task.runId,
        created_at: Date.now(),
        content: options.content,
      },
      user_info: {
        app_id: "795647",
        consumer_uid: userInfo.consumer_uid,
        ...(options.includeSpaceId
          ? { space_id: boundedString(userInfo.space_id, "XiaoYunque space id", 1_024) }
          : {}),
        workspace_id: userInfo.workspace_id,
      },
      agent_name: options.agentName,
      entrance_from: "web",
      run_extra: context.body,
    }
    await options.beforeSubmit?.()
    const query = new URLSearchParams({ babi_param: context.query })
    const response = await this.#jsonRequest(`${submitPath}?${query}`, body, session, signal)
    const payload = requireSuccess(response.value, response.status, `XiaoYunque ${options.editType} generation`)
    if (!record(payload.data)) throw new Error("XiaoYunque generation submission returned an invalid response")
  }

  async #userInfo(session: StoredWebSession, signal: AbortSignal): Promise<XiaoYunqueUserInfo> {
    const identityResponse = await this.#jsonRequest(odinUserInfoPath, {}, session, signal)
    const identityPayload = requireSuccess(
      identityResponse.value,
      identityResponse.status,
      "XiaoYunque identity lookup",
    )
    const identity = record(identityPayload.data)
    if (!identity) throw new Error("XiaoYunque identity lookup returned an invalid response")
    const consumerUid = boundedString(identity.user_id, "XiaoYunque consumer uid", 1_024)

    const workspaceResponse = await this.#jsonRequest(userWorkspacePath, {
      uid: consumerUid,
    }, session, signal)
    const workspacePayload = requireSuccess(
      workspaceResponse.value,
      workspaceResponse.status,
      "XiaoYunque workspace lookup",
    )
    const workspace = record(workspacePayload.data)
    if (!workspace) throw new Error("XiaoYunque workspace lookup returned an invalid response")
    return {
      consumer_uid: consumerUid,
      ...(workspace.space_id === undefined || workspace.space_id === null || workspace.space_id === ""
        ? {}
        : { space_id: boundedString(workspace.space_id, "XiaoYunque space id", 1_024) }),
      workspace_id: boundedString(workspace.workspace_id, "XiaoYunque workspace id", 1_024),
    }
  }

  async #queryRun(task: RemoteTask, session: StoredWebSession, signal: AbortSignal) {
    const response = await this.#jsonRequest(getThreadPath, {
      thread_id: task.threadId,
      run_id: task.runId,
      scopes: ["run_list.entry_list"],
    }, session, signal)
    const payload = requireSuccess(response.value, response.status, "XiaoYunque generation status")
    const data = record(payload.data)
    const thread = record(data?.thread)
    if (!thread || !Array.isArray(thread.run_list) || thread.run_list.length > 256) {
      throw new Error("XiaoYunque generation status is invalid")
    }
    if (thread.thread_id !== undefined && thread.thread_id !== task.threadId) {
      throw new Error("XiaoYunque generation status task does not match")
    }
    const run = thread.run_list.map(record).find((candidate) => candidate?.run_id === task.runId)
    if (!run) return { run_id: task.runId, thread_id: task.threadId, state: 0, entry_list: [] }
    if (run.thread_id !== undefined && run.thread_id !== task.threadId) {
      throw new Error("XiaoYunque generation status task does not match")
    }
    return run
  }

  async #jsonRequest(
    path: string,
    body: Record<string, unknown>,
    session: StoredWebSession,
    signal: AbortSignal,
  ) {
    return this.#request(path, session, signal, {
      body: JSON.stringify(body),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    })
  }

  async #request(
    path: string,
    session: StoredWebSession,
    signal: AbortSignal,
    init: Pick<RequestInit, "body" | "headers" | "method">,
  ) {
    const url = new URL(path, this.#baseUrl)
    const cookieUrl = this.#allowLoopbackTest ? new URL(path, xiaoYunqueCookieOrigin) : url
    const cookie = webSessionCookieHeader(session.cookies, cookieUrl)
    if (!cookie) throw new XiaoYunqueAuthenticationError("XiaoYunque authorization is no longer valid")
    const headers = new Headers(init.headers)
    headers.set("Accept", "application/json")
    headers.set("Cookie", cookie)
    headers.set("appvr", "1.1.4")
    headers.set("entrance-from", "web")
    headers.set("appid", "795647")
    headers.set("pf", "7")
    const response = await this.#fetch(url, {
      ...init,
      headers,
      signal,
    })
    const value = await boundedJson(response, "XiaoYunque")
    return { status: response.status, value }
  }
}
