const PROTOCOL = "convax.plugin-host/3"
const CONNECTED_MEDIA_CHANGED = "canvas.connectedMedia.changed"
const TOOL_PREFIX = "subtitle-studio/"
const REQUEST_TIMEOUT_MS = 30_000
const OPERATION_TIMEOUT_MS = 6 * 60 * 60 * 1_000
const MAX_SUBTITLE_DOCUMENT_BYTES = 236 * 1024

const elements = Object.fromEntries(
  [
    "activeTrack", "busy", "busyText", "cancel", "captions", "cueEnd", "cueIdentity", "cueStart", "cueText", "deleteCue", "empty", "emptyTrack", "eraseHard", "erasePanel",
    "eraseSoft", "eraseSoft", "export", "exportSrt", "hardErase", "inspect", "language", "meta", "model",
    "importSrt", "play", "preview", "previewHard", "publish", "regionHeight", "regionWidth", "regionX", "regionY", "softErase",
    "saveCue", "sourceTrack", "srtFile", "status", "streams", "targetLanguage", "time", "title", "toast", "trackLabel", "tracks",
    "transcribe", "translate", "translatedLabel", "video",
  ].map((id) => [id, document.getElementById(id)]),
)

const state = {
  activeTrackId: "",
  artifact: null,
  context: null,
  document: null,
  documentSourceVersion: "",
  editingCue: null,
  media: [],
  muxedArtifact: null,
  playback: null,
  previewArtifact: null,
  source: null,
  tools: null,
}

let hostPort = null
let requestSequence = 0
let activeOperationRequestId = ""
let captionResizeObserver = null
let saveTimer = 0
let toastTimer = 0
const pending = new Map()

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error)
}

function showToast(message) {
  window.clearTimeout(toastTimer)
  elements.toast.textContent = message
  elements.toast.hidden = false
  toastTimer = window.setTimeout(() => {
    elements.toast.hidden = true
  }, 4_000)
}

function setBusy(label) {
  elements.busyText.textContent = label
  elements.cancel.hidden = true
  elements.busy.hidden = false
}

function clearBusy() {
  activeOperationRequestId = ""
  elements.cancel.hidden = true
  elements.busy.hidden = true
}

function sendRequest(method, params, timeoutMs = REQUEST_TIMEOUT_MS) {
  if (!hostPort) return { id: "", promise: Promise.reject(new Error("插件尚未连接 Convax")) }
  const id = `subtitle_${Date.now()}_${++requestSequence}`
  const promise = new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => {
      pending.delete(id)
      reject(new Error("Convax 请求超时"))
    }, timeoutMs)
    pending.set(id, { reject, resolve, timer })
    hostPort.postMessage({ id, method, ...(params === undefined ? {} : { params }), protocol: PROTOCOL, type: "request" })
  })
  return { id, promise }
}

function request(method, params, timeoutMs) {
  return sendRequest(method, params, timeoutMs).promise
}

function receiveHostMessage(event) {
  const message = event.data
  if (!isRecord(message) || message.protocol !== PROTOCOL) return
  if (message.type === "command") {
    if (message.command === CONNECTED_MEDIA_CHANGED) void refreshConnectedMedia()
    return
  }
  if (message.type !== "response" || typeof message.id !== "string") return
  const entry = pending.get(message.id)
  if (!entry) return
  pending.delete(message.id)
  window.clearTimeout(entry.timer)
  if (message.ok === true) entry.resolve(message.result)
  else entry.reject(new Error(typeof message.error === "string" ? message.error : "Convax 请求失败"))
}

function connectHost(event) {
  const message = event.data
  if (
    event.source !== window.parent ||
    !isRecord(message) ||
    message.type !== "connect" ||
    message.protocol !== PROTOCOL ||
    message.pluginId !== "subtitle-studio"
  ) return
  const port = event.ports?.[0]
  if (!port || hostPort) return
  window.removeEventListener("message", connectHost)
  hostPort = port
  hostPort.onmessage = receiveHostMessage
  hostPort.start()
  void initialize()
}

window.addEventListener("message", connectHost)

function nodeState(context) {
  const metadata = context?.node?.data?.metadata
  const value = isRecord(metadata) ? metadata.convaxPluginState : undefined
  return isRecord(value) ? value : {}
}

function validCue(value) {
  return isRecord(value)
    && typeof value.id === "string"
    && Number.isSafeInteger(value.startMs)
    && Number.isSafeInteger(value.endMs)
    && value.endMs > value.startMs
    && typeof value.text === "string"
    && value.text.trim().length > 0
}

function validTrack(value) {
  return isRecord(value)
    && typeof value.id === "string"
    && typeof value.language === "string"
    && (value.kind === "source" || value.kind === "translation")
    && Array.isArray(value.cues)
    && value.cues.every(validCue)
}

function hydrateDocument(value) {
  if (!isRecord(value) || value.schema !== "convax.subtitle/1" || !Array.isArray(value.tracks)) return null
  const tracks = value.tracks.filter(validTrack).slice(0, 32).map((track) => ({
    cues: track.cues.slice(0, 20_000).map((cue) => ({
      endMs: cue.endMs,
      id: cue.id,
      startMs: cue.startMs,
      text: cue.text,
    })),
    id: track.id,
    kind: track.kind,
    ...(typeof track.label === "string" ? { label: track.label } : {}),
    language: track.language,
    ...(typeof track.sourceTrackId === "string" ? { sourceTrackId: track.sourceTrackId } : {}),
  }))
  return {
    id: typeof value.id === "string" ? value.id : crypto.randomUUID(),
    provenance: Array.isArray(value.provenance) ? value.provenance.slice(-50) : [],
    revision: Number.isSafeInteger(value.revision) ? value.revision : 0,
    schema: "convax.subtitle/1",
    source: isRecord(value.source) ? value.source : { durationMs: 0, mediaName: "video" },
    tracks,
  }
}

function persistedState() {
  return {
    activeTrackId: state.activeTrackId,
    ...(state.document ? {
      document: state.document,
      sourceVersion: state.documentSourceVersion,
    } : {}),
  }
}

function scheduleSave() {
  window.clearTimeout(saveTimer)
  saveTimer = window.setTimeout(async () => {
    try {
      const snapshot = persistedState()
      if (new TextEncoder().encode(JSON.stringify(snapshot)).byteLength > MAX_SUBTITLE_DOCUMENT_BYTES) {
        throw new Error("字幕文档过大，请先拆分视频或减少轨道")
      }
      await request("canvas.node.updateState", { state: snapshot })
    } catch (error) {
      showToast(`保存字幕状态失败：${errorMessage(error)}`)
    }
  }, 180)
}

function formatTime(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return "00:00"
  const total = Math.floor(seconds)
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor(total / 60) % 60
  const remaining = total % 60
  return hours
    ? `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(remaining).padStart(2, "0")}`
    : `${String(minutes).padStart(2, "0")}:${String(remaining).padStart(2, "0")}`
}

function activeTrack() {
  return state.document?.tracks.find((track) => track.id === state.activeTrackId) ?? null
}

function renderCaption() {
  const track = activeTrack()
  const timeMs = Math.round(elements.video.currentTime * 1_000)
  const cue = track?.cues.find((item) => item.startMs <= timeMs && timeMs < item.endMs)
  elements.captions.replaceChildren()
  if (!cue) return
  const span = document.createElement("span")
  span.textContent = cue.text
  elements.captions.append(span)
}

function updateCaptionGeometry() {
  const containerWidth = elements.video.clientWidth
  const containerHeight = elements.video.clientHeight
  const mediaWidth = elements.video.videoWidth
  const mediaHeight = elements.video.videoHeight
  if (![containerWidth, containerHeight, mediaWidth, mediaHeight].every((value) => Number.isFinite(value) && value > 0)) {
    elements.captions.removeAttribute("style")
    return
  }
  const scale = Math.min(containerWidth / mediaWidth, containerHeight / mediaHeight)
  const width = mediaWidth * scale
  const height = mediaHeight * scale
  const left = (containerWidth - width) / 2
  const top = (containerHeight - height) / 2
  elements.captions.style.bottom = `${containerHeight - top - height + height * 0.096}px`
  elements.captions.style.fontSize = `${width * 0.022}px`
  elements.captions.style.left = `${left + width * 0.09}px`
  elements.captions.style.right = "auto"
  elements.captions.style.width = `${width * 0.82}px`
}

function renderTime() {
  elements.time.textContent = `${formatTime(elements.video.currentTime)} / ${formatTime(elements.video.duration)}`
  elements.play.textContent = elements.video.paused ? "▶" : "Ⅱ"
  elements.play.setAttribute("aria-label", elements.video.paused ? "播放" : "暂停")
  renderCaption()
}

function renderDocument() {
  const tracks = state.document?.tracks ?? []
  if (!tracks.some((track) => track.id === state.activeTrackId)) state.activeTrackId = tracks[0]?.id ?? ""
  elements.activeTrack.replaceChildren()
  elements.sourceTrack.replaceChildren()
  for (const track of tracks) {
    const title = track.label || track.language
    const option = document.createElement("option")
    option.value = track.id
    option.textContent = `${track.language} · ${title}`
    elements.activeTrack.append(option)
    const sourceOption = option.cloneNode(true)
    elements.sourceTrack.append(sourceOption)
  }
  elements.activeTrack.value = state.activeTrackId
  elements.sourceTrack.value = tracks.find((track) => track.kind === "source")?.id ?? tracks[0]?.id ?? ""
  elements.activeTrack.disabled = tracks.length === 0
  elements.translate.disabled = tracks.length === 0 || !state.source
  elements.exportSrt.disabled = tracks.length === 0
  elements.title.textContent = tracks.length ? `${tracks.length} 条字幕轨道` : "尚未制作字幕"
  elements.meta.textContent = tracks.length
    ? `${tracks.reduce((total, track) => total + track.cues.length, 0)} 条字幕 · 当前 ${activeTrack()?.language ?? "—"}`
    : "多语言软字幕轨道会显示在这里"

  elements.tracks.replaceChildren()
  if (!tracks.length) {
    const empty = document.createElement("p")
    empty.textContent = "制作或翻译字幕后，轨道会出现在这里。"
    elements.tracks.append(empty)
    renderCaption()
    return
  }
  const measuredDurationMs = Math.round(elements.video.duration * 1_000)
  const durationMs = Math.max(1, state.document?.source?.durationMs ?? (measuredDurationMs || 1))
  for (const track of tracks) {
    const row = document.createElement("div")
    row.className = `track${track.id === state.activeTrackId ? " active" : ""}`
    row.dataset.trackId = track.id
    const info = document.createElement("div")
    info.className = "track-info"
    const name = document.createElement("strong")
    name.textContent = track.label || track.language
    const detail = document.createElement("span")
    detail.textContent = `${track.language} · ${track.cues.length} cues`
    info.append(name, detail)
    const cues = document.createElement("div")
    cues.className = "track-cues"
    for (const cue of track.cues) {
      const item = document.createElement("span")
      item.className = "cue"
      item.title = cue.text
      item.style.left = `${Math.max(0, Math.min(100, cue.startMs / durationMs * 100))}%`
      item.style.width = `${Math.max(0.2, Math.min(100, (cue.endMs - cue.startMs) / durationMs * 100))}%`
      item.addEventListener("click", (event) => {
        event.stopPropagation()
        openCueEditor(track, cue)
      })
      cues.append(item)
    }
    const remove = document.createElement("button")
    remove.type = "button"
    remove.textContent = "×"
    remove.title = "删除轨道"
    remove.addEventListener("click", (event) => {
      event.stopPropagation()
      state.document.tracks = state.document.tracks.filter((candidate) => candidate.id !== track.id && candidate.sourceTrackId !== track.id)
      state.document.revision += 1
      renderDocument()
      scheduleSave()
    })
    const actions = document.createElement("div")
    actions.className = "track-actions"
    if (track.kind === "source") {
      const add = document.createElement("button")
      add.type = "button"
      add.textContent = "+"
      add.title = "在播放位置新增字幕"
      add.addEventListener("click", (event) => {
        event.stopPropagation()
        createCueAtCurrentTime(track)
      })
      actions.append(add)
    }
    actions.append(remove)
    row.append(info, cues, actions)
    row.addEventListener("click", () => {
      state.activeTrackId = track.id
      renderDocument()
      scheduleSave()
    })
    elements.tracks.append(row)
  }
  renderCaption()
}

function renderSource() {
  const ready = Boolean(state.source)
  const metadataReady = ready && Number.isFinite(elements.video.duration) && elements.video.duration > 0
  elements.empty.hidden = ready
  elements.play.disabled = !ready
  elements.transcribe.disabled = !ready
  elements.importSrt.disabled = !metadataReady
  elements.emptyTrack.disabled = !metadataReady
  elements.inspect.disabled = !ready
  elements.previewHard.disabled = !ready
  elements.eraseHard.disabled = !ready
  elements.publish.disabled = !ready
  elements.export.disabled = !ready
  elements.status.textContent = state.artifact?.name || state.source?.name || "等待连接视频"
}

async function closePlayback() {
  const playback = state.playback
  state.playback = null
  if (!playback) return
  await request("canvas.connectedMedia.playback.close", { playbackId: playback.playbackId }).catch(() => undefined)
}

async function releaseArtifact() {
  const artifacts = [state.artifact, state.muxedArtifact]
  state.artifact = null
  state.muxedArtifact = null
  const ids = [...new Set(artifacts.map((artifact) => artifact?.artifactId).filter(Boolean))]
  await Promise.all(ids.map((artifactId) =>
    request("generation.workspace.release", { artifactId }).catch(() => undefined),
  ))
}

async function releasePreviewArtifact() {
  const artifact = state.previewArtifact
  state.previewArtifact = null
  if (!artifact?.artifactId) return
  await request("generation.workspace.release", { artifactId: artifact.artifactId }).catch(() => undefined)
}

async function openSource(source) {
  if (typeof source.sourceVersion !== "string" || !/^[a-f0-9]{64}$/u.test(source.sourceVersion)) {
    throw new Error("Convax 返回了无效的视频来源版本")
  }
  await closePlayback()
  await releaseArtifact()
  await releasePreviewArtifact()
  const playback = await request("canvas.connectedMedia.playback.open", { nodeId: source.nodeId })
  if (!isRecord(playback) || typeof playback.playbackId !== "string" || typeof playback.url !== "string") {
    throw new Error("Convax 返回了无效的视频播放句柄")
  }
  const sourceChanged = Boolean(state.document && state.documentSourceVersion !== source.sourceVersion)
  if (sourceChanged) {
    state.document = null
    state.activeTrackId = ""
    state.editingCue = null
  }
  state.documentSourceVersion = source.sourceVersion
  state.source = source
  state.playback = playback
  elements.preview.hidden = true
  elements.video.src = playback.url
  elements.video.load()
  if (sourceChanged) {
    renderDocument()
    scheduleSave()
    showToast("已连接新视频，原视频的字幕轨道未沿用")
  }
  renderSource()
}

async function refreshConnectedMedia() {
  try {
    const result = await request("canvas.connectedMedia.list")
    const media = isRecord(result) && Array.isArray(result.media) ? result.media.filter((item) =>
      isRecord(item)
        && typeof item.nodeId === "string"
        && typeof item.mimeType === "string"
        && item.mimeType.startsWith("video/")
        && typeof item.sourceVersion === "string"
        && /^[a-f0-9]{64}$/u.test(item.sourceVersion),
    ) : []
    state.media = media
    if (!media[0]) {
      await closePlayback()
      await releaseArtifact()
      await releasePreviewArtifact()
      state.source = null
      elements.video.removeAttribute("src")
      elements.video.load()
      renderSource()
      return
    }
    const source = media.find((item) => item.nodeId === state.source?.nodeId) ?? media[0]
    if (
      state.playback
      && source.nodeId === state.source?.nodeId
      && source.sourceVersion === state.source?.sourceVersion
    ) {
      state.source = source
      renderSource()
      return
    }
    await openSource(source)
  } catch (error) {
    await closePlayback()
    await releaseArtifact()
    await releasePreviewArtifact()
    state.source = null
    elements.video.removeAttribute("src")
    elements.video.load()
    renderSource()
    showToast(`无法读取画布视频：${errorMessage(error)}`)
  }
}

async function generationTools() {
  if (state.tools) return state.tools
  const result = await request("generation.tools.list")
  state.tools = isRecord(result) && Array.isArray(result.tools) ? result.tools : []
  return state.tools
}

async function executeWorkspace(localToolId, input, label) {
  if (!state.source) throw new Error("请先连接一个视频")
  const tools = await generationTools()
  const id = `${TOOL_PREFIX}${localToolId}`
  if (!tools.some((tool) => tool?.id === id)) throw new Error(`本地工具尚未就绪：${localToolId}`)
  setBusy(label)
  const requestEntry = sendRequest("generation.workspace.execute", {
    output: input.output,
    prompt: input.prompt,
    references: [state.artifact
      ? { artifactId: state.artifact.artifactId, role: "reference_video" }
      : { nodeId: state.source.nodeId, role: "reference_video" }],
    toolId: id,
    toolInput: input.toolInput ?? {},
  }, OPERATION_TIMEOUT_MS)
  activeOperationRequestId = requestEntry.id
  elements.cancel.hidden = false
  try {
    const result = await requestEntry.promise
    if (!isRecord(result) || !Array.isArray(result.outputs)) throw new Error("本地工具返回了无效结果")
    if (Array.isArray(result.warnings)) result.warnings.forEach((warning) => showToast(String(warning)))
    return result.outputs
  } finally {
    clearBusy()
  }
}

function textOutput(outputs) {
  const output = outputs.find((item) => isRecord(item) && item.kind === "text")
  if (!output || typeof output.text !== "string") throw new Error("本地工具没有返回字幕文本")
  return output.text
}

function artifactOutput(outputs, kind) {
  const output = outputs.find((item) => isRecord(item) && item.kind === "artifact")
  if (!output || typeof output.artifactId !== "string" || typeof output.url !== "string") {
    throw new Error("本地工具没有返回可播放结果")
  }
  if (kind && typeof output.mimeType === "string" && !output.mimeType.startsWith(`${kind}/`)) {
    throw new Error("本地工具返回了错误的媒体类型")
  }
  return output
}

function setArtifact(artifact) {
  const previous = state.artifact
  const previousMuxed = state.muxedArtifact
  state.artifact = artifact
  state.muxedArtifact = null
  elements.preview.hidden = true
  elements.video.src = artifact.url
  elements.video.load()
  renderSource()
  void releasePreviewArtifact()
  if (previous?.artifactId && previous.artifactId !== artifact.artifactId) {
    void request("generation.workspace.release", { artifactId: previous.artifactId }).catch(() => undefined)
  }
  if (previousMuxed?.artifactId && previousMuxed.artifactId !== artifact.artifactId && previousMuxed.artifactId !== previous?.artifactId) {
    void request("generation.workspace.release", { artifactId: previousMuxed.artifactId }).catch(() => undefined)
  }
}

function ensureDocument() {
  if (state.document) return state.document
  if (!state.source?.sourceVersion) throw new Error("请先连接一个视频")
  state.documentSourceVersion = state.source.sourceVersion
  state.document = {
    id: `document_${crypto.randomUUID()}`,
    provenance: [],
    revision: 0,
    schema: "convax.subtitle/1",
    source: {
      durationMs: Math.max(0, Math.round((elements.video.duration || 0) * 1_000)),
      mediaName: state.source?.name || "video",
    },
    tracks: [],
  }
  return state.document
}

function parseSrtTimestamp(value) {
  const match = /^(\d{1,9}):(\d{2}):(\d{2})[,.](\d{3})$/u.exec(value.trim())
  if (!match) throw new Error(`无效 SRT 时间：${value}`)
  const [, hours, minutes, seconds, milliseconds] = match.map(Number)
  if (minutes > 59 || seconds > 59) throw new Error(`无效 SRT 时间：${value}`)
  const result = ((hours * 60 + minutes) * 60 + seconds) * 1_000 + milliseconds
  if (!Number.isSafeInteger(result)) throw new Error("SRT 时间超出支持范围")
  return result
}

function parseSrt(value) {
  const blocks = value.replace(/^\uFEFF/u, "").replaceAll("\r\n", "\n").replaceAll("\r", "\n").trim().split(/\n[\t ]*\n+/u)
  return blocks.filter(Boolean).map((block, index) => {
    const lines = block.split("\n")
    const timelineIndex = lines[0]?.includes("-->") ? 0 : 1
    const timeline = lines[timelineIndex]?.split(/\s*-->\s*/u)
    if (!timeline || timeline.length !== 2) throw new Error(`SRT 字幕 ${index + 1} 缺少时间轴`)
    const startMs = parseSrtTimestamp(timeline[0].split(/\s/u, 1)[0])
    const endMs = parseSrtTimestamp(timeline[1].split(/\s/u, 1)[0])
    const text = lines.slice(timelineIndex + 1).join("\n").trim()
    if (endMs <= startMs || !text || text.includes("\n\n")) throw new Error(`SRT 字幕 ${index + 1} 无效`)
    return { endMs, id: `cue_${crypto.randomUUID()}`, startMs, text }
  }).sort((left, right) => left.startMs - right.startMs)
}

async function importSrtFile(file) {
  try {
    if (!file || file.size < 1 || file.size > 2 * 1024 * 1024) throw new Error("SRT 文件必须小于 2 MiB")
    const cues = parseSrt(await file.text())
    if (!cues.length) throw new Error("SRT 文件没有字幕")
    const documentValue = ensureDocument()
    const track = {
      cues,
      id: `track_${crypto.randomUUID()}`,
      kind: "source",
      label: elements.trackLabel.value.trim() || file.name.replace(/\.srt$/iu, "") || "导入字幕",
      language: elements.language.value === "auto" ? "und" : elements.language.value,
    }
    documentValue.tracks.push(track)
    documentValue.provenance.push({ createdAt: new Date().toISOString(), mode: "imported" })
    documentValue.revision += 1
    state.activeTrackId = track.id
    renderDocument()
    scheduleSave()
    closePanels()
  } catch (error) {
    showToast(`导入 SRT 失败：${errorMessage(error)}`)
  } finally {
    elements.srtFile.value = ""
  }
}

function createEmptyTrack() {
  const documentValue = ensureDocument()
  const track = {
    cues: [],
    id: `track_${crypto.randomUUID()}`,
    kind: "source",
    label: elements.trackLabel.value.trim() || "空字幕轨道",
    language: elements.language.value === "auto" ? "und" : elements.language.value,
  }
  documentValue.tracks.push(track)
  documentValue.provenance.push({ createdAt: new Date().toISOString(), mode: "edited" })
  documentValue.revision += 1
  state.activeTrackId = track.id
  renderDocument()
  scheduleSave()
  closePanels()
}

async function transcribe() {
  try {
    const outputs = await executeWorkspace("subtitle.transcribe", {
      output: "text",
      prompt: "Transcribe the directly connected video's audio into an editable soft-subtitle document.",
      toolInput: { language: elements.language.value, model: elements.model.value },
    }, "正在本机提取音轨并转写…")
    const parsed = JSON.parse(textOutput(outputs))
    const documentValue = hydrateDocument(parsed)
    if (!documentValue || documentValue.tracks.length === 0) throw new Error("转写结果不包含字幕轨道")
    documentValue.tracks[0].label = elements.trackLabel.value.trim() || documentValue.tracks[0].label || "原文"
    state.document = documentValue
    state.documentSourceVersion = state.source.sourceVersion
    state.activeTrackId = documentValue.tracks[0].id
    renderDocument()
    scheduleSave()
    closePanels()
  } catch (error) {
    showToast(`转写失败：${errorMessage(error)}`)
  }
}

async function inspectVideo() {
  try {
    const outputs = await executeWorkspace("subtitle.inspect", {
      output: "text",
      prompt: "Inspect embedded text-subtitle and audio streams.",
    }, "正在检查视频流…")
    const value = JSON.parse(textOutput(outputs))
    const streams = Array.isArray(value?.subtitleStreams) ? value.subtitleStreams : []
    elements.streams.replaceChildren()
    if (!streams.length) {
      const empty = document.createElement("p")
      empty.textContent = "原视频没有可移除的内嵌软字幕流。"
      elements.streams.append(empty)
    }
    for (const stream of streams) {
      if (!isRecord(stream) || !Number.isSafeInteger(stream.index)) continue
      const row = document.createElement("label")
      row.className = "stream"
      const checkbox = document.createElement("input")
      checkbox.type = "checkbox"
      checkbox.value = String(stream.index)
      checkbox.checked = true
      const label = document.createElement("span")
      label.textContent = `${stream.language || "und"} · ${stream.title || `字幕流 ${stream.index}`}`
      row.append(checkbox, label)
      elements.streams.append(row)
    }
    elements.eraseSoft.disabled = streams.length === 0
  } catch (error) {
    showToast(`检查失败：${errorMessage(error)}`)
  }
}

function regionInput() {
  const region = {
    x: Number(elements.regionX.value),
    y: Number(elements.regionY.value),
    width: Number(elements.regionWidth.value),
    height: Number(elements.regionHeight.value),
  }
  if (Object.values(region).some((value) => !Number.isFinite(value)) || region.x < 0 || region.y < 0 || region.width <= 0 || region.height <= 0 || region.x + region.width > 1 || region.y + region.height > 1) {
    throw new Error("字幕区域必须位于视频画面内")
  }
  return region
}

async function eraseSoft() {
  try {
    const stream_indexes = [...elements.streams.querySelectorAll('input[type="checkbox"]:checked')].map((input) => Number(input.value))
    if (!stream_indexes.length) throw new Error("请选择要移除的字幕流")
    const outputs = await executeWorkspace("subtitle.erase-soft", {
      output: "video",
      prompt: "Remove the selected embedded text-subtitle streams without re-encoding the picture.",
      toolInput: { stream_indexes_json: JSON.stringify(stream_indexes) },
    }, "正在移除内嵌软字幕…")
    setArtifact(artifactOutput(outputs, "video"))
    closePanels()
  } catch (error) {
    showToast(`软字幕擦除失败：${errorMessage(error)}`)
  }
}

async function previewHard() {
  try {
    const outputs = await executeWorkspace("subtitle.preview-hard", {
      output: "image",
      prompt: "Preview the bounded hard-subtitle search region.",
      toolInput: { ...regionInput(), timestamp_ms: Math.round(elements.video.currentTime * 1_000) },
    }, "正在生成预览…")
    const artifact = artifactOutput(outputs, "image")
    const previous = state.previewArtifact
    state.previewArtifact = artifact
    elements.preview.src = artifact.url
    elements.preview.hidden = false
    if (previous?.artifactId && previous.artifactId !== artifact.artifactId) {
      void request("generation.workspace.release", { artifactId: previous.artifactId }).catch(() => undefined)
    }
  } catch (error) {
    showToast(`预览失败：${errorMessage(error)}`)
  }
}

async function eraseHard() {
  try {
    const outputs = await executeWorkspace("subtitle.erase-hard", {
      output: "video",
      prompt: "Detect and inpaint burned-in subtitles only inside the bounded search region.",
      toolInput: regionInput(),
    }, "正在使用本地 AI 擦除硬字幕…")
    setArtifact(artifactOutput(outputs, "video"))
    closePanels()
  } catch (error) {
    showToast(`硬字幕擦除失败：${errorMessage(error)}`)
  }
}

function compactTrackForTranslation(track) {
  return track.cues.map((cue) => ({ id: cue.id, text: cue.text }))
}

function translationBatches(track) {
  const batches = []
  let current = []
  let size = 2
  for (const cue of compactTrackForTranslation(track)) {
    const serialized = JSON.stringify(cue)
    if (current.length && (current.length >= 120 || size + serialized.length + 1 > 12_000)) {
      batches.push(current)
      current = []
      size = 2
    }
    if (serialized.length > 12_000) throw new Error(`字幕过长，无法安全翻译：${cue.id}`)
    current.push(cue)
    size += serialized.length + 1
  }
  if (current.length) batches.push(current)
  return batches
}

function parseTranslationResponse(text) {
  const match = text.match(/\[[\s\S]*\]/u)
  if (!match) throw new Error("翻译结果不是 JSON 数组")
  const value = JSON.parse(match[0])
  if (!Array.isArray(value)) throw new Error("翻译结果不是 JSON 数组")
  return value
}

async function translateTrack() {
  const source = state.document?.tracks.find((track) => track.id === elements.sourceTrack.value)
  if (!source) return showToast("请选择源字幕轨道")
  const targetLanguage = elements.targetLanguage.value.trim()
  if (!targetLanguage) return showToast("请输入目标语言")
  setBusy("正在翻译字幕…")
  try {
    const batches = translationBatches(source)
    const translated = []
    for (const [index, batch] of batches.entries()) {
      elements.busyText.textContent = `正在翻译字幕 ${index + 1} / ${batches.length}…`
      const result = await request("agent.prompt", {
        mode: "text-only",
        text: [
          `Translate every subtitle into ${targetLanguage}.`,
          "Return only a JSON array. Preserve each id exactly and emit objects with exactly id and text.",
          "Do not merge, split, omit, reorder, explain, or add timestamps.",
          JSON.stringify(batch),
        ].join("\n\n"),
      }, OPERATION_TIMEOUT_MS)
      if (!isRecord(result) || typeof result.text !== "string") throw new Error("Agent 没有返回文本")
      translated.push(...parseTranslationResponse(result.text))
    }
    if (!Array.isArray(translated) || translated.length !== source.cues.length) throw new Error("翻译结果改变了字幕数量")
    const byId = new Map(translated.map((item) => [item?.id, item?.text]))
    const cues = source.cues.map((cue) => {
      const text = byId.get(cue.id)
      if (typeof text !== "string" || !text.trim()) throw new Error(`翻译缺少 cue：${cue.id}`)
      return { ...cue, text: text.trim() }
    })
    const track = {
      cues,
      id: `track_${crypto.randomUUID()}`,
      kind: "translation",
      label: elements.translatedLabel.value.trim() || targetLanguage,
      language: targetLanguage,
      sourceTrackId: source.id,
    }
    state.document.tracks.push(track)
    state.document.provenance.push({ createdAt: new Date().toISOString(), engine: "Convax Agent text-only", mode: "translated" })
    state.document.revision += 1
    state.activeTrackId = track.id
    renderDocument()
    scheduleSave()
    closePanels()
  } catch (error) {
    showToast(`翻译失败：${errorMessage(error)}`)
  } finally {
    clearBusy()
  }
}

function srtTimestamp(milliseconds) {
  const hours = Math.floor(milliseconds / 3_600_000)
  const minutes = Math.floor(milliseconds / 60_000) % 60
  const seconds = Math.floor(milliseconds / 1_000) % 60
  const remainder = milliseconds % 1_000
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")},${String(remainder).padStart(3, "0")}`
}

function trackSrt(track) {
  return `${track.cues.map((cue, index) => `${index + 1}\n${srtTimestamp(cue.startMs)} --> ${srtTimestamp(cue.endMs)}\n${cue.text}`).join("\n\n")}\n`
}

function textTracksPayload() {
  return (state.document?.tracks ?? []).map((track) => ({
    content: trackSrt(track),
    default: track.id === state.activeTrackId,
    format: "srt",
    label: track.label || track.language,
    language: track.language,
  }))
}

async function ensureMuxedArtifact() {
  if (!(state.document?.tracks.length)) return state.artifact
  if (
    state.muxedArtifact?.subtitleDocumentRevision === state.document.revision &&
    state.muxedArtifact?.subtitleActiveTrackId === state.activeTrackId
  ) return state.muxedArtifact
  const tracks = [...state.document.tracks]
  tracks.sort((left, right) => Number(right.id === state.activeTrackId) - Number(left.id === state.activeTrackId))
  const documentForMux = { ...state.document, tracks }
  const serializedDocument = JSON.stringify(documentForMux)
  if (new TextEncoder().encode(serializedDocument).byteLength > MAX_SUBTITLE_DOCUMENT_BYTES) {
    throw new Error("字幕文档过大，无法安全封装")
  }
  const outputs = await executeWorkspace("subtitle.mux-soft", {
    output: "video",
    prompt: "Package the current editable soft-subtitle tracks into the player video without burning them into pixels.",
    toolInput: { subtitle_document_json: serializedDocument },
  }, "正在封装软字幕…")
  const artifact = artifactOutput(outputs, "video")
  artifact.subtitleDocumentRevision = state.document.revision
  artifact.subtitleActiveTrackId = state.activeTrackId
  const previous = state.muxedArtifact
  state.muxedArtifact = artifact
  if (previous?.artifactId && previous.artifactId !== artifact.artifactId) {
    void request("generation.workspace.release", { artifactId: previous.artifactId }).catch(() => undefined)
  }
  return artifact
}

async function publishCurrent() {
  try {
    const artifact = await ensureMuxedArtifact()
    setBusy("正在添加到画布…")
    const result = await request("generation.workspace.publish", {
      ...(artifact ? { artifactId: artifact.artifactId } : { sourceNodeId: state.source.nodeId }),
      textTracks: textTracksPayload(),
    }, OPERATION_TIMEOUT_MS)
    if (!isRecord(result) || !Array.isArray(result.createdNodeIds)) throw new Error("画布没有返回新节点")
    showToast("已把播放器当前内容添加到画布")
  } catch (error) {
    showToast(`添加到画布失败：${errorMessage(error)}`)
  } finally {
    clearBusy()
  }
}

async function exportCurrent() {
  try {
    const artifact = await ensureMuxedArtifact()
    setBusy("正在导出视频…")
    const result = await request("generation.workspace.export", {
      ...(artifact ? { artifactId: artifact.artifactId } : { sourceNodeId: state.source.nodeId }),
      suggestedName: artifact?.name || state.source.name,
    }, OPERATION_TIMEOUT_MS)
    if (result?.status === "saved") showToast("视频已导出")
  } catch (error) {
    showToast(`导出失败：${errorMessage(error)}`)
  } finally {
    clearBusy()
  }
}

async function exportActiveSrt() {
  const track = activeTrack()
  if (!track) return
  try {
    await request("host.file.exportText", {
      content: trackSrt(track),
      mimeType: "application/x-subrip",
      suggestedName: `${track.label || track.language}.srt`,
    })
  } catch (error) {
    showToast(`导出 SRT 失败：${errorMessage(error)}`)
  }
}

function openCueEditor(track, cue) {
  closePanels()
  state.editingCue = { cueId: cue.id, trackId: track.id }
  elements.cueIdentity.textContent = `${track.label || track.language} · ${cue.id}`
  elements.cueStart.value = String(cue.startMs)
  elements.cueEnd.value = String(cue.endMs)
  elements.cueText.value = cue.text
  const translation = track.kind === "translation"
  elements.cueStart.disabled = translation
  elements.cueEnd.disabled = translation
  elements.deleteCue.disabled = translation
  document.getElementById("editPanel").hidden = false
}

function createCueAtCurrentTime(track) {
  if (!state.document || track.kind !== "source") return
  const measuredDurationMs = Math.round(elements.video.duration * 1_000)
  const durationMs = Math.max(1_000, measuredDurationMs || state.document.source.durationMs || 1_000)
  const requestedStartMs = Math.max(0, Math.round(elements.video.currentTime * 1_000))
  const startMs = Math.min(requestedStartMs, durationMs - 1)
  const cue = {
    endMs: Math.min(durationMs, startMs + 2_000),
    id: `cue_${crypto.randomUUID()}`,
    startMs,
    text: "新字幕",
  }
  track.cues.push(cue)
  track.cues.sort((left, right) => left.startMs - right.startMs)
  const derivedCount = state.document.tracks.filter((candidate) => candidate.sourceTrackId === track.id).length
  if (derivedCount) {
    state.document.tracks = state.document.tracks.filter((candidate) => candidate.sourceTrackId !== track.id)
    showToast("源字幕结构已变化，请重新生成翻译轨道")
  }
  state.document.provenance.push({ createdAt: new Date().toISOString(), mode: "edited" })
  state.document.revision += 1
  state.activeTrackId = track.id
  renderDocument()
  scheduleSave()
  openCueEditor(track, cue)
}

function editingCue() {
  const ref = state.editingCue
  const track = state.document?.tracks.find((candidate) => candidate.id === ref?.trackId)
  const cue = track?.cues.find((candidate) => candidate.id === ref?.cueId)
  return track && cue ? { cue, track } : null
}

function saveCue() {
  const selected = editingCue()
  if (!selected) return closePanels()
  const text = elements.cueText.value.trim()
  const startMs = Number(elements.cueStart.value)
  const endMs = Number(elements.cueEnd.value)
  if (!text || text.includes("\n\n") || !Number.isSafeInteger(startMs) || !Number.isSafeInteger(endMs) || startMs < 0 || endMs <= startMs) {
    return showToast("字幕文本或时间无效")
  }
  if (selected.track.kind === "source") {
    const index = selected.track.cues.indexOf(selected.cue)
    const previous = selected.track.cues[index - 1]
    const next = selected.track.cues[index + 1]
    if ((previous && startMs < previous.startMs) || (next && startMs > next.startMs)) {
      return showToast("调整时间不能跨过相邻字幕片段")
    }
    selected.cue.startMs = startMs
    selected.cue.endMs = endMs
    for (const track of state.document.tracks) {
      if (track.sourceTrackId !== selected.track.id || !track.cues[index]) continue
      track.cues[index].startMs = startMs
      track.cues[index].endMs = endMs
    }
  }
  selected.cue.text = text
  state.document.provenance.push({ createdAt: new Date().toISOString(), mode: "edited" })
  state.document.revision += 1
  renderDocument()
  scheduleSave()
  closePanels()
}

function deleteCue() {
  const selected = editingCue()
  if (!selected || selected.track.kind !== "source") return
  const index = selected.track.cues.indexOf(selected.cue)
  selected.track.cues.splice(index, 1)
  for (const track of state.document.tracks) {
    if (track.sourceTrackId === selected.track.id) track.cues.splice(index, 1)
  }
  state.document.provenance.push({ createdAt: new Date().toISOString(), mode: "edited" })
  state.document.revision += 1
  renderDocument()
  scheduleSave()
  closePanels()
}

function closePanels() {
  state.editingCue = null
  elements.preview.hidden = true
  void releasePreviewArtifact()
  document.querySelectorAll(".popover").forEach((panel) => { panel.hidden = true })
  document.querySelectorAll(".actions [data-panel]").forEach((button) => button.classList.remove("active"))
}

function togglePanel(name) {
  const panel = document.getElementById(`${name}Panel`)
  const wasHidden = panel.hidden
  closePanels()
  if (!wasHidden) return
  panel.hidden = false
  document.querySelector(`.actions [data-panel="${name}"]`)?.classList.add("active")
}

function bindEvents() {
  document.querySelectorAll(".actions [data-panel]").forEach((button) => button.addEventListener("click", () => togglePanel(button.dataset.panel)))
  document.querySelectorAll("[data-close]").forEach((button) => button.addEventListener("click", closePanels))
  document.querySelectorAll("[data-mode]").forEach((button) => button.addEventListener("click", () => {
    document.querySelectorAll("[data-mode]").forEach((candidate) => candidate.classList.toggle("active", candidate === button))
    elements.softErase.hidden = button.dataset.mode !== "soft"
    elements.hardErase.hidden = button.dataset.mode !== "hard"
  }))
  elements.play.addEventListener("click", () => elements.video.paused ? elements.video.play() : elements.video.pause())
  elements.video.addEventListener("timeupdate", renderTime)
  elements.video.addEventListener("durationchange", renderTime)
  elements.video.addEventListener("loadedmetadata", () => {
    updateCaptionGeometry()
    renderSource()
  })
  elements.video.addEventListener("play", renderTime)
  elements.video.addEventListener("pause", renderTime)
  elements.activeTrack.addEventListener("change", () => {
    state.activeTrackId = elements.activeTrack.value
    renderDocument()
    scheduleSave()
  })
  elements.transcribe.addEventListener("click", transcribe)
  elements.importSrt.addEventListener("click", () => elements.srtFile.click())
  elements.srtFile.addEventListener("change", () => void importSrtFile(elements.srtFile.files?.[0]))
  elements.emptyTrack.addEventListener("click", createEmptyTrack)
  elements.inspect.addEventListener("click", inspectVideo)
  elements.eraseSoft.addEventListener("click", eraseSoft)
  elements.previewHard.addEventListener("click", previewHard)
  elements.eraseHard.addEventListener("click", eraseHard)
  elements.translate.addEventListener("click", translateTrack)
  elements.publish.addEventListener("click", publishCurrent)
  elements.export.addEventListener("click", exportCurrent)
  elements.exportSrt.addEventListener("click", exportActiveSrt)
  elements.saveCue.addEventListener("click", saveCue)
  elements.deleteCue.addEventListener("click", deleteCue)
  if (typeof ResizeObserver === "function") {
    captionResizeObserver = new ResizeObserver(updateCaptionGeometry)
    captionResizeObserver.observe(elements.video)
  }
  elements.cancel.addEventListener("click", () => {
    if (!activeOperationRequestId) return
    void request("generation.workspace.cancel", { requestId: activeOperationRequestId }).catch(() => undefined)
    elements.busyText.textContent = "正在取消…"
  })
  window.addEventListener("beforeunload", () => {
    void closePlayback()
    void releaseArtifact()
    void releasePreviewArtifact()
    captionResizeObserver?.disconnect()
  })
}

async function initialize() {
  bindEvents()
  try {
    state.context = await request("host.context.get")
    const persisted = nodeState(state.context)
    state.document = hydrateDocument(persisted.document)
    state.documentSourceVersion = typeof persisted.sourceVersion === "string" && /^[a-f0-9]{64}$/u.test(persisted.sourceVersion)
      ? persisted.sourceVersion
      : ""
    state.activeTrackId = typeof persisted.activeTrackId === "string" ? persisted.activeTrackId : ""
    renderDocument()
    await refreshConnectedMedia()
  } catch (error) {
    showToast(`Subtitle Studio 启动失败：${errorMessage(error)}`)
  }
}
