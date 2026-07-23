import {
  ANGLE_PRESETS,
  MAX_SELECTED_PRESETS,
  MIN_SELECTED_PRESETS,
  SUBJECT_TYPES,
  createDefaultState,
  createGenerationRequest,
  createMultiAngleGridPrompt,
  executeGridGeneration,
  hydratePluginState,
  normalizeGenerationResult,
  normalizeGenerationTools,
  presetById,
} from "./multi-angle-model.js"

const HOST_PROTOCOL = "convax.plugin-host/3"
const PLUGIN_ID = "multi-angle"
const CONNECTIONS_CHANGED_COMMAND = "canvas.connectedImages.changed"
const GENERATE_COMMAND = "multi-angle.generate"
const REFRESH_COMMAND = "multi-angle.refresh"
const REQUEST_TIMEOUT = 30000
const STATE_SAVE_DELAY = 240

const elements = {
  actionHint: document.getElementById("actionHint"),
  actionTitle: document.getElementById("actionTitle"),
  connectionPill: document.getElementById("connectionPill"),
  connectionText: document.getElementById("connectionText"),
  emptySource: document.getElementById("emptySource"),
  generateButton: document.getElementById("generateButton"),
  generateLabel: document.getElementById("generateLabel"),
  loadingOverlay: document.getElementById("loadingOverlay"),
  loadingText: document.getElementById("loadingText"),
  messagePanel: document.getElementById("messagePanel"),
  messageText: document.getElementById("messageText"),
  messageTitle: document.getElementById("messageTitle"),
  modelCount: document.getElementById("modelCount"),
  notesCount: document.getElementById("notesCount"),
  notesInput: document.getElementById("notesInput"),
  presetGrid: document.getElementById("presetGrid"),
  refreshButton: document.getElementById("refreshButton"),
  resultsGrid: document.getElementById("resultsGrid"),
  runStatus: document.getElementById("runStatus"),
  runStatusText: document.getElementById("runStatusText"),
  selectionCount: document.getElementById("selectionCount"),
  sourceHelp: document.getElementById("sourceHelp"),
  sourceImage: document.getElementById("sourceImage"),
  sourceOverlay: document.getElementById("sourceOverlay"),
  sourceSelect: document.getElementById("sourceSelect"),
  sourceSelectShell: document.getElementById("sourceSelectShell"),
  sourceSize: document.getElementById("sourceSize"),
  sourceStage: document.getElementById("sourceStage"),
  subjectTypes: document.getElementById("subjectTypes"),
  toast: document.getElementById("toast"),
  toolHelp: document.getElementById("toolHelp"),
  toolSelect: document.getElementById("toolSelect"),
}

let hostPort = null
let requestSequence = 0
let pendingRequests = new Map()
let pluginContext = null
let pluginState = createDefaultState()
let hydrationSource = "empty"
let connectedImages = []
let generationTools = []
let sourceDataUrl = ""
let sourceLoadSequence = 0
let refreshPromise = null
let refreshQueued = false
let runActive = false
let stateWritesSuspended = false
let stateSaveTimer = 0
let stateSaveDirty = false
let stateSavePromise = null
let toastTimer = 0

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
}

function setHidden(element, hidden) {
  element.classList.toggle("is-hidden", hidden)
}

function errorMessage(error, fallback) {
  return error instanceof Error && error.message ? error.message : fallback
}

function showToast(message, tone = "info") {
  window.clearTimeout(toastTimer)
  elements.toast.textContent = message
  elements.toast.classList.remove("is-hidden", "is-error", "is-warning")
  if (tone === "error") elements.toast.classList.add("is-error")
  if (tone === "warning") elements.toast.classList.add("is-warning")
  toastTimer = window.setTimeout(function () {
    elements.toast.classList.add("is-hidden")
  }, tone === "error" ? 5600 : 3600)
}

function setConnectionState(connected) {
  elements.connectionPill.classList.toggle("is-connected", connected)
  elements.connectionText.textContent = connected ? "画布已连接" : "等待宿主"
}

function setLoading(active, text) {
  if (text) elements.loadingText.textContent = text
  setHidden(elements.loadingOverlay, !active)
}

function rejectPendingRequests(error) {
  for (const pending of pendingRequests.values()) {
    if (pending.timeout !== null) window.clearTimeout(pending.timeout)
    pending.reject(error)
  }
  pendingRequests.clear()
}

function hostRequest(method, params, timeoutMs) {
  if (!hostPort) return Promise.reject(new Error("Convax Plugin host is not connected"))
  const id = "multi-angle-" + String(++requestSequence)
  const request = {
    id,
    method,
    ...(params === undefined ? {} : { params }),
    protocol: HOST_PROTOCOL,
    type: "request",
  }
  return new Promise(function (resolve, reject) {
    const requestTimeout = timeoutMs === undefined ? REQUEST_TIMEOUT : timeoutMs
    const timeout = requestTimeout === null ? null : window.setTimeout(function () {
      pendingRequests.delete(id)
      reject(new Error("插件宿主请求超时"))
    }, requestTimeout)
    pendingRequests.set(id, { reject, resolve, timeout })
    try {
      hostPort.postMessage(request)
    } catch (error) {
      if (timeout !== null) window.clearTimeout(timeout)
      pendingRequests.delete(id)
      reject(error)
    }
  })
}

function handlePortMessage(event) {
  const message = event.data
  if (!isRecord(message) || message.protocol !== HOST_PROTOCOL) return
  if (message.type === "response" && typeof message.id === "string" && typeof message.ok === "boolean") {
    const pending = pendingRequests.get(message.id)
    if (!pending) return
    pendingRequests.delete(message.id)
    if (pending.timeout !== null) window.clearTimeout(pending.timeout)
    if (message.ok) pending.resolve(message.result)
    else pending.reject(new Error(typeof message.error === "string" ? message.error : "Convax Plugin request failed"))
    return
  }
  if (message.type !== "command" || typeof message.command !== "string") return
  if (message.command === CONNECTIONS_CHANGED_COMMAND || message.command === REFRESH_COMMAND) {
    if (runActive) refreshQueued = true
    else void refreshAll(true)
  } else if (message.command === GENERATE_COMMAND) {
    void runGeneration()
  }
}

function handleWindowMessage(event) {
  if (hostPort || event.source !== window.parent || event.ports.length !== 1) return
  const message = event.data
  if (!isRecord(message) || message.protocol !== HOST_PROTOCOL || message.type !== "connect" || message.pluginId !== PLUGIN_ID) return
  window.removeEventListener("message", handleWindowMessage)
  hostPort = event.ports[0]
  hostPort.onmessage = handlePortMessage
  hostPort.start()
  setConnectionState(true)
  void hydrateFromHost()
}

function pluginStateFromContext(context) {
  if (!isRecord(context) || !isRecord(context.node) || !isRecord(context.node.data)) return null
  const metadata = context.node.data.metadata
  return isRecord(metadata) ? metadata.convaxPluginState : null
}

function queueStateSave() {
  stateSaveDirty = true
  window.clearTimeout(stateSaveTimer)
  if (stateWritesSuspended) return
  stateSaveTimer = window.setTimeout(function () { void flushStateSave() }, STATE_SAVE_DELAY)
}

async function flushStateSave() {
  window.clearTimeout(stateSaveTimer)
  if (!hostPort || stateWritesSuspended) return
  if (stateSavePromise) {
    await stateSavePromise
    if (stateSaveDirty && !stateWritesSuspended) return flushStateSave()
    return
  }
  if (!stateSaveDirty) return
  const snapshot = pluginState
  stateSaveDirty = false
  stateSavePromise = hostRequest("canvas.node.updateState", { state: snapshot })
  try {
    await stateSavePromise
  } catch (error) {
    stateSaveDirty = true
    showToast(errorMessage(error, "无法保存多角度配置"), "error")
    throw error
  } finally {
    stateSavePromise = null
  }
  if (stateSaveDirty && !stateWritesSuspended) await flushStateSave()
}

function postStateSnapshotBestEffort() {
  if (!hostPort || runActive || stateWritesSuspended || hydrationSource === "unsupported") return
  try {
    hostPort.postMessage({
      id: "multi-angle-unload-" + String(++requestSequence),
      method: "canvas.node.updateState",
      params: { state: pluginState },
      protocol: HOST_PROTOCOL,
      type: "request",
    })
  } catch {
    // The owning Canvas keeps the last state snapshot already accepted by the host.
  }
}

async function hydrateFromHost() {
  try {
    const context = await hostRequest("host.context.get")
    if (!isRecord(context) || !isRecord(context.canvas) || !isRecord(context.node)) {
      throw new Error("宿主返回了无效的插件上下文")
    }
    pluginContext = context
    const hydrated = hydratePluginState(pluginStateFromContext(context))
    hydrationSource = hydrated.source
    pluginState = hydrated.state
    renderAll()
    await refreshAll(true)
  } catch (error) {
    showToast(errorMessage(error, "无法读取插件上下文"), "error")
  }
}

function normalizeConnectedImages(result) {
  if (!isRecord(result) || !Array.isArray(result.images)) return []
  return result.images.filter(function (image) {
    return isRecord(image) && typeof image.id === "string" && typeof image.name === "string"
      && typeof image.readable === "boolean"
  }).map(function (image) {
    return {
      height: typeof image.height === "number" ? image.height : undefined,
      id: image.id,
      mimeType: typeof image.mimeType === "string" ? image.mimeType : undefined,
      name: image.name,
      readable: image.readable,
      width: typeof image.width === "number" ? image.width : undefined,
    }
  })
}

function chooseSourceImage() {
  return connectedImages.find((image) => image.id === pluginState.sourceNodeId && image.readable)
    ?? connectedImages.find((image) => image.readable)
    ?? null
}

async function readSelectedSource(force) {
  const source = chooseSourceImage()
  const sequence = ++sourceLoadSequence
  if (!source) {
    sourceDataUrl = ""
    setLoading(false)
    renderSource()
    renderActions()
    return
  }
  if (!force && source.id === pluginState.sourceNodeId && sourceDataUrl) return
  sourceDataUrl = ""
  setLoading(true, "正在读取参考图…")
  renderSource()
  try {
    const result = await hostRequest("canvas.connectedImage.read", { nodeId: source.id })
    if (!isRecord(result) || typeof result.dataUrl !== "string" || typeof result.mimeType !== "string") {
      throw new Error("宿主没有返回可预览的参考图")
    }
    if (sequence === sourceLoadSequence && pluginState.sourceNodeId === source.id) sourceDataUrl = result.dataUrl
  } catch (error) {
    if (sequence === sourceLoadSequence) showToast(errorMessage(error, "参考图预览失败；仍可尝试通过统一生成接口处理该节点。"), "warning")
  } finally {
    if (sequence === sourceLoadSequence) {
      setLoading(false)
      renderSource()
      renderActions()
    }
  }
}

async function refreshTools() {
  const result = await hostRequest("generation.tools.list", { output: "image" })
  generationTools = normalizeGenerationTools(result)
  if (!generationTools.some((tool) => tool.id === pluginState.toolId)) {
    pluginState = { ...pluginState, toolId: generationTools[0]?.id ?? null }
  }
}

async function refreshConnectedImages(force) {
  const previousSourceId = pluginState.sourceNodeId
  connectedImages = normalizeConnectedImages(await hostRequest("canvas.connectedImages.list"))
  const source = chooseSourceImage()
  if (source?.id !== previousSourceId) {
    pluginState = {
      ...pluginState,
      lastRun: null,
      result: null,
      sourceNodeId: source?.id ?? null,
    }
    sourceDataUrl = ""
  }
  renderAll()
  await readSelectedSource(force)
}

async function refreshAll(force = false) {
  if (!hostPort) return
  if (runActive) {
    refreshQueued = true
    return
  }
  if (refreshPromise) {
    refreshQueued = refreshQueued || force
    return refreshPromise
  }
  refreshPromise = (async function () {
    try {
      await refreshTools()
      await refreshConnectedImages(force)
      renderAll()
    } catch (error) {
      showToast(errorMessage(error, "刷新参考图与生图模型失败"), "error")
    }
  })()
  try {
    await refreshPromise
  } finally {
    refreshPromise = null
    if (refreshQueued && !runActive) {
      const queuedForce = refreshQueued
      refreshQueued = false
      void refreshAll(queuedForce)
    }
  }
}

function resetRunForPlanChange() {
  pluginState = { ...pluginState, lastRun: null, result: null }
  hydrationSource = "current"
}

function renderSubjectTypes() {
  const focusedElement = document.activeElement
  const focusedId = focusedElement instanceof HTMLElement && elements.subjectTypes.contains(focusedElement)
    ? focusedElement.dataset.subjectId
    : null
  let focusTarget = null
  elements.subjectTypes.replaceChildren()
  for (const subject of SUBJECT_TYPES) {
    const button = document.createElement("button")
    button.className = "segment-button" + (pluginState.subjectType === subject.id ? " is-active" : "")
    button.dataset.subjectId = subject.id
    button.disabled = runActive
    button.type = "button"
    button.textContent = subject.label
    button.setAttribute("aria-pressed", String(pluginState.subjectType === subject.id))
    button.addEventListener("click", function () {
      if (runActive || pluginState.subjectType === subject.id) return
      pluginState = { ...pluginState, subjectType: subject.id }
      resetRunForPlanChange()
      queueStateSave()
      renderAll()
    })
    if (focusedId === subject.id) focusTarget = button
    elements.subjectTypes.append(button)
  }
  focusTarget?.focus({ preventScroll: true })
}

function renderPresetButtons() {
  const focusedElement = document.activeElement
  const focusedId = focusedElement instanceof HTMLElement && elements.presetGrid.contains(focusedElement)
    ? focusedElement.dataset.presetId
    : null
  let focusTarget = null
  elements.presetGrid.replaceChildren()
  for (const preset of ANGLE_PRESETS) {
    const active = pluginState.selectedPresetIds.includes(preset.id)
    const button = document.createElement("button")
    button.className = "preset-button" + (active ? " is-active" : "")
    button.dataset.presetId = preset.id
    button.disabled = runActive
    button.type = "button"
    button.setAttribute("aria-pressed", String(active))
    const copy = document.createElement("span")
    const label = document.createElement("strong")
    const shortLabel = document.createElement("small")
    const check = document.createElement("span")
    label.textContent = preset.label
    shortLabel.textContent = preset.shortLabel
    check.className = "preset-check"
    check.textContent = "✓"
    copy.append(label, shortLabel)
    button.append(copy, check)
    button.addEventListener("click", function () {
      if (runActive) return
      const selected = pluginState.selectedPresetIds
      if (!active && selected.length >= MAX_SELECTED_PRESETS) {
        showToast("单次最多选择 " + String(MAX_SELECTED_PRESETS) + " 个视角。", "warning")
        return
      }
      pluginState = {
        ...pluginState,
        selectedPresetIds: active ? selected.filter((id) => id !== preset.id) : [...selected, preset.id],
      }
      resetRunForPlanChange()
      queueStateSave()
      renderAll()
    })
    if (focusedId === preset.id) focusTarget = button
    elements.presetGrid.append(button)
  }
  focusTarget?.focus({ preventScroll: true })
}

function renderTools() {
  elements.toolSelect.replaceChildren()
  if (!generationTools.length) {
    const option = document.createElement("option")
    option.textContent = "未发现可用 AI 图片模型"
    option.value = ""
    elements.toolSelect.append(option)
    elements.toolSelect.disabled = true
    elements.modelCount.textContent = "0 个可用"
    elements.toolHelp.textContent = "请先安装并配置一个声明为 model 且支持参考图的图片生成 Tool Plugin。"
    return
  }
  for (const tool of generationTools) {
    const option = document.createElement("option")
    option.textContent = tool.title
    option.value = tool.id
    elements.toolSelect.append(option)
  }
  elements.toolSelect.value = pluginState.toolId ?? generationTools[0].id
  elements.toolSelect.disabled = runActive
  elements.modelCount.textContent = String(generationTools.length) + " 个可用"
  const selected = generationTools.find((tool) => tool.id === elements.toolSelect.value)
  elements.toolHelp.textContent = selected?.description || "模型由已安装的统一 Generation Tool Plugin 提供。"
}

function renderSource() {
  elements.sourceSelect.replaceChildren()
  for (const image of connectedImages) {
    const option = document.createElement("option")
    option.value = image.id
    option.disabled = !image.readable
    option.textContent = image.name + (image.readable ? "" : "（不可读取）")
    elements.sourceSelect.append(option)
  }
  if (pluginState.sourceNodeId) elements.sourceSelect.value = pluginState.sourceNodeId
  elements.sourceSelect.disabled = runActive
  setHidden(elements.sourceSelectShell, connectedImages.length === 0)

  const source = chooseSourceImage()
  const hasPreview = Boolean(source && sourceDataUrl)
  elements.sourceStage.classList.toggle("has-image", hasPreview)
  setHidden(elements.emptySource, hasPreview)
  setHidden(elements.sourceImage, !hasPreview)
  setHidden(elements.sourceOverlay, !hasPreview)
  if (hasPreview) {
    elements.sourceImage.src = sourceDataUrl
    elements.sourceImage.alt = "多角度参考图：" + source.name
    elements.sourceSize.textContent = source.width && source.height
      ? String(source.width) + " × " + String(source.height)
      : source.mimeType ?? "IMAGE"
  } else {
    elements.sourceImage.removeAttribute("src")
  }
  if (!connectedImages.length) elements.sourceHelp.textContent = "从 Canvas 图片节点连线到此节点；插件不能读取未连接的素材。"
  else if (!source) elements.sourceHelp.textContent = "当前连接中没有可用的 JPEG、PNG 或 WebP 图片。"
  else if (!hasPreview) elements.sourceHelp.textContent = "当前参考：" + source.name + "。预览不可用时仍可由宿主尝试生成。"
  else elements.sourceHelp.textContent = "当前参考：" + source.name + "。切换来源会开始一份新的镜头方案。"
}

function resultCard(presetIds) {
  const result = pluginState.result
  const failed = Boolean(pluginState.lastRun?.failure) && !runActive
  const running = runActive
  const card = document.createElement("article")
  card.className = "result-card" + (result ? " is-success" : running ? " is-running" : failed ? " is-failed" : "")

  const heading = document.createElement("div")
  heading.className = "result-heading"
  const angle = document.createElement("div")
  angle.className = "result-angle"
  const name = document.createElement("strong")
  const shortLabel = document.createElement("small")
  name.textContent = "多角度宫格图"
  shortLabel.textContent = presetIds.map((presetId) => presetById(presetId)?.shortLabel ?? presetId).join(" · ")
  angle.append(name, shortLabel)
  const icon = document.createElement("span")
  icon.className = "result-icon"
  icon.textContent = result ? "✓" : failed ? "!" : running ? "◌" : "◇"
  heading.append(angle, icon)

  const copy = document.createElement("div")
  copy.className = "result-copy"
  const summary = document.createElement("span")
  const nodeIds = document.createElement("code")
  if (result) {
    summary.textContent = "已创建 " + String(result.createdNodeIds.length) + " 个 Canvas 图片节点，内容为 " + String(result.presetIds.length) + " 宫格"
    nodeIds.textContent = result.createdNodeIds.join(" · ")
  } else if (running) {
    summary.textContent = "正在通过统一接口一次生成完整的 " + String(presetIds.length) + " 宫格图…"
    nodeIds.textContent = "关闭或移除插件节点会由宿主取消当前任务"
  } else if (failed) {
    summary.textContent = "本次宫格图未完成"
    nodeIds.textContent = pluginState.lastRun.failure.message
  } else {
    summary.textContent = "等待一次生成整张多角度宫格图"
    nodeIds.textContent = "最终只会在 Canvas 中创建一张结果图片"
  }
  copy.append(summary, nodeIds)

  const meta = document.createElement("div")
  meta.className = "result-meta"
  const status = document.createElement("span")
  status.className = "result-status" + (result ? " is-success" : running ? " is-running" : failed ? " is-failed" : "")
  status.textContent = result ? "已提交" : running ? "生成中" : failed ? "失败" : "待生成"
  const warnings = document.createElement("span")
  warnings.textContent = result?.warnings.length ? String(result.warnings.length) + " 条提示" : ""
  meta.append(status, warnings)
  card.append(heading, copy, meta)
  return card
}

function renderResults() {
  const run = pluginState.lastRun
  const presetIds = run?.presetIds ?? pluginState.selectedPresetIds
  elements.resultsGrid.replaceChildren(resultCard(presetIds))
  elements.runStatus.className = "run-status is-idle"
  let statusText = "等待生成"
  if (runActive) {
    elements.runStatus.className = "run-status is-running"
    statusText = "正在生成 1 张 " + String(presetIds.length) + " 宫格图"
  } else if (run?.status === "success") {
    elements.runStatus.className = "run-status is-success"
    statusText = "已完成 1 张 " + String(run.presetIds.length) + " 宫格图"
  } else if (run?.status === "failed") {
    elements.runStatus.className = "run-status is-error"
    statusText = "生成失败"
  } else if (run?.status === "interrupted") {
    elements.runStatus.className = "run-status is-warning"
    statusText = "上次任务已中断"
  }
  elements.runStatusText.textContent = statusText

  let title = ""
  let message = ""
  let tone = ""
  if (hydrationSource === "unsupported") {
    title = "状态版本不受支持"
    message = "当前节点保留了未知版本状态；只有在你主动修改或生成后，插件才会写入新格式。"
  } else if (!generationTools.length && hostPort) {
    title = "没有可用的 AI 图片模型"
    message = "安装并配置一个支持 reference_image 的图片 model Tool Plugin 后，再刷新此节点。"
  } else if (run?.failure) {
    title = run.status === "interrupted" ? "上次生成被中断" : "宫格图生成失败"
    message = run.failure.message
    tone = run.status === "failed" ? "is-error" : ""
  } else {
    const warningCount = pluginState.result?.warnings.length ?? 0
    if (warningCount) {
      title = "生成工具提示"
      message = "本次返回 " + String(warningCount) + " 条工具提示；宫格结果节点已由宿主正常提交到 Canvas。"
    }
  }
  elements.messagePanel.className = "message-panel" + (tone ? " " + tone : "")
  setHidden(elements.messagePanel, !message)
  elements.messageTitle.textContent = title
  elements.messageText.textContent = message
}

function renderActions() {
  const selectedCount = pluginState.selectedPresetIds.length
  const source = chooseSourceImage()
  const tool = generationTools.find((candidate) => candidate.id === pluginState.toolId)
  elements.selectionCount.textContent = "已选 " + String(selectedCount) + " / " + String(MAX_SELECTED_PRESETS)
  elements.notesCount.value = pluginState.notes.length + " / 1000"
  elements.notesCount.textContent = pluginState.notes.length + " / 1000"
  if (elements.notesInput.value !== pluginState.notes) elements.notesInput.value = pluginState.notes
  elements.notesInput.disabled = runActive
  elements.refreshButton.disabled = runActive
  elements.actionTitle.textContent = selectedCount >= MIN_SELECTED_PRESETS
    ? "准备生成 1 张 " + String(selectedCount) + " 宫格图片"
    : "至少选择两个视角"
  if (!source) elements.actionHint.textContent = "先从 Canvas 连接并选择一张参考图"
  else if (!tool) elements.actionHint.textContent = "先安装或选择一个支持参考图的 AI 图片模型"
  else elements.actionHint.textContent = "将通过“" + tool.title + "”发起 1 次统一生图，输出一张多宫格图片"
  elements.generateButton.disabled = runActive || !hostPort || !pluginContext || !source || !tool
    || selectedCount < MIN_SELECTED_PRESETS
  elements.generateLabel.textContent = runActive ? "宫格图生成中…" : "生成宫格图"
}

function renderAll() {
  renderTools()
  renderSubjectTypes()
  renderPresetButtons()
  renderSource()
  renderResults()
  renderActions()
}

async function runGeneration() {
  if (runActive) return
  const source = chooseSourceImage()
  const tool = generationTools.find((candidate) => candidate.id === pluginState.toolId)
  const presetIds = [...pluginState.selectedPresetIds]
  if (!source) {
    showToast("请先连接并选择一张参考图。", "warning")
    return
  }
  if (!tool) {
    showToast("请先安装或选择一个可用的 AI 图片模型。", "warning")
    return
  }
  if (presetIds.length < MIN_SELECTED_PRESETS) {
    showToast("请至少选择两个视角。", "warning")
    return
  }

  runActive = true
  const startedAt = new Date().toISOString()
  pluginState = {
    ...pluginState,
    lastRun: {
      completedAt: "",
      failure: null,
      presetIds,
      sourceNodeId: source.id,
      startedAt,
      status: "running",
      toolId: tool.id,
    },
    result: null,
    sourceNodeId: source.id,
    toolId: tool.id,
  }
  hydrationSource = "current"
  queueStateSave()
  renderAll()

  try {
    await flushStateSave()
  } catch {
    runActive = false
    pluginState = {
      ...pluginState,
      lastRun: {
        ...pluginState.lastRun,
        completedAt: new Date().toISOString(),
        failure: { message: "无法在生成前保存当前宫格方案。" },
        status: "failed",
      },
    }
    renderAll()
    return
  }

  stateWritesSuspended = true
  const outcome = await executeGridGeneration({
    execute: async function () {
      const prompt = createMultiAngleGridPrompt({
        notes: pluginState.notes,
        presetIds,
        subjectType: pluginState.subjectType,
      })
      const request = createGenerationRequest({ prompt, sourceNodeId: source.id, toolId: tool.id })
      // Generation has no client deadline. The host owns queued-job polling,
      // frame cancellation, stale-scope checks, managed assets and Canvas commit.
      const rawResult = await hostRequest("generation.canvas.execute", request, null)
      return normalizeGenerationResult(rawResult, presetIds, new Date().toISOString())
    },
  })

  const completedAt = new Date().toISOString()
  pluginState = {
    ...pluginState,
    lastRun: {
      ...pluginState.lastRun,
      completedAt,
      failure: outcome.failure,
      status: outcome.failure ? "failed" : "success",
    },
    result: outcome.result,
  }
  stateWritesSuspended = false
  queueStateSave()
  try {
    await flushStateSave()
  } catch {
    // The Canvas results are already authoritative even if this UI snapshot cannot be saved.
  }
  runActive = false
  renderAll()
  if (outcome.failure) {
    showToast("多角度宫格图生成失败。", "error")
  } else {
    showToast("已将一张 " + String(presetIds.length) + " 宫格多角度图提交到 Canvas。")
  }
  if (refreshQueued) {
    refreshQueued = false
    void refreshAll(true)
  }
}

function bindEvents() {
  window.addEventListener("message", handleWindowMessage)
  window.addEventListener("beforeunload", function () {
    postStateSnapshotBestEffort()
    window.clearTimeout(stateSaveTimer)
    window.clearTimeout(toastTimer)
    rejectPendingRequests(new Error("插件页面已关闭"))
    if (hostPort) {
      hostPort.onmessage = null
      hostPort.close()
      hostPort = null
    }
  })
  elements.refreshButton.addEventListener("click", function () {
    if (!runActive) void refreshAll(true)
  })
  elements.generateButton.addEventListener("click", function () { void runGeneration() })
  elements.sourceSelect.addEventListener("change", function () {
    if (runActive) return
    const source = connectedImages.find((image) => image.id === elements.sourceSelect.value && image.readable)
    if (!source || source.id === pluginState.sourceNodeId) return
    pluginState = { ...pluginState, sourceNodeId: source.id }
    sourceDataUrl = ""
    resetRunForPlanChange()
    queueStateSave()
    renderAll()
    void readSelectedSource(true)
  })
  elements.toolSelect.addEventListener("change", function () {
    if (runActive || !generationTools.some((tool) => tool.id === elements.toolSelect.value)) return
    pluginState = { ...pluginState, toolId: elements.toolSelect.value }
    resetRunForPlanChange()
    queueStateSave()
    renderAll()
  })
  elements.notesInput.addEventListener("input", function () {
    if (runActive) return
    pluginState = { ...pluginState, notes: elements.notesInput.value.slice(0, 1000) }
    resetRunForPlanChange()
    queueStateSave()
    renderResults()
    renderActions()
  })
  elements.notesInput.addEventListener("change", function () {
    if (!runActive) void flushStateSave()
  })
}

function boot() {
  bindEvents()
  setConnectionState(false)
  renderAll()
}

boot()
