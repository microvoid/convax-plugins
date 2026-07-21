import { RelightRenderer } from "./relight-renderer.js"
import { buildRelightGenerationRequest, normalizeGenerationTools } from "./generation.js"

const HOST_PROTOCOL = "convax.plugin-host/3"
const PLUGIN_ID = "relight-studio"
const CONNECTED_IMAGES_CHANGED = "canvas.connectedImages.changed"
const MAX_IMAGE_FILE_BYTES = 16 * 1024 * 1024
const MAX_IMAGE_PIXELS = 40 * 1024 * 1024
const STATE_SAVE_DELAY = 300
const STATE_SAVE_MAX_ATTEMPTS = 3
const DEFAULT_REQUEST_TIMEOUT_MS = 20_000
const ACCEPTED_IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp"])

const PRESETS = {
  cinematic: {
    lightX: 0.25,
    lightY: 0.24,
    intensity: 1.18,
    softness: 0.62,
    exposure: -0.03,
    temperature: 0.18,
    shadows: 0.28,
    contrast: 1.12,
    saturation: 1.05,
    vignette: 0.3,
    depth: 0.46,
    rim: 0.42,
    keyColor: [1.08, 0.97, 0.84],
    shadowColor: [0.84, 0.92, 1.02],
    rimColor: [0.58, 0.82, 1.08],
  },
  studio: {
    lightX: 0.35,
    lightY: 0.18,
    intensity: 0.92,
    softness: 0.9,
    exposure: 0.1,
    temperature: 0.02,
    shadows: 0.58,
    contrast: 1.02,
    saturation: 0.98,
    vignette: 0.1,
    depth: 0.46,
    rim: 0.25,
    keyColor: [1.04, 1.01, 0.96],
    shadowColor: [0.94, 0.97, 1.02],
    rimColor: [0.92, 0.97, 1.08],
  },
  sunset: {
    lightX: 0.14,
    lightY: 0.42,
    intensity: 1.34,
    softness: 0.7,
    exposure: -0.08,
    temperature: 0.72,
    shadows: 0.2,
    contrast: 1.14,
    saturation: 1.14,
    vignette: 0.32,
    depth: 0.76,
    rim: 0.7,
    keyColor: [1.28, 0.76, 0.42],
    shadowColor: [0.84, 0.72, 0.92],
    rimColor: [1.12, 0.64, 0.64],
  },
  neon: {
    lightX: 0.76,
    lightY: 0.28,
    intensity: 1.22,
    softness: 0.52,
    exposure: -0.16,
    temperature: -0.3,
    shadows: 0.16,
    contrast: 1.2,
    saturation: 1.28,
    vignette: 0.46,
    depth: 1,
    rim: 1,
    keyColor: [0.48, 0.92, 1.25],
    shadowColor: [0.78, 0.58, 0.94],
    rimColor: [1.12, 0.44, 0.86],
  },
  moonlight: {
    lightX: 0.68,
    lightY: 0.12,
    intensity: 0.98,
    softness: 0.68,
    exposure: -0.28,
    temperature: -0.76,
    shadows: 0.14,
    contrast: 1.14,
    saturation: 0.82,
    vignette: 0.5,
    depth: 0.88,
    rim: 0.84,
    keyColor: [0.62, 0.82, 1.24],
    shadowColor: [0.68, 0.75, 0.94],
    rimColor: [0.58, 0.78, 1.12],
  },
  natural: {
    lightX: 0.42,
    lightY: 0.2,
    intensity: 0.66,
    softness: 0.88,
    exposure: 0.08,
    temperature: 0.08,
    shadows: 0.48,
    contrast: 1.01,
    saturation: 1.01,
    vignette: 0.08,
    depth: 0.34,
    rim: 0.16,
    keyColor: [1.04, 1, 0.94],
    shadowColor: [0.9, 0.95, 1.02],
    rimColor: [0.9, 0.98, 1.06],
  },
}

const PRESET_PROMPTS = {
  cinematic: "电影级冷暖对比光，暖色主光配合克制的冷色轮廓光，层次清晰但不过度戏剧化",
  studio: "高端摄影棚柔光，干净均匀的主体塑形与柔和自然的接触阴影",
  sunset: "日落时刻的低角度金色主光，带有柔和暖色边缘光和真实环境反射",
  neon: "夜景霓虹氛围，青蓝主光与洋红轮廓光形成电影感色彩对比",
  moonlight: "克制的蓝调月光，冷色方向光与深而保留细节的阴影",
  natural: "自然窗光提亮，肤色或产品颜色准确，明暗过渡轻柔真实",
  custom: "按照下列精确参数设计自定义主光、环境光和轮廓光",
}

const elements = {
  additionalPrompt: document.getElementById("additionalPrompt"),
  chooseButton: document.getElementById("chooseButton"),
  compareButton: document.getElementById("compareButton"),
  compareLabel: document.getElementById("compareLabel"),
  connectionPill: document.getElementById("connectionPill"),
  connectionText: document.getElementById("connectionText"),
  dragHint: document.getElementById("dragHint"),
  emptyChooseButton: document.getElementById("emptyChooseButton"),
  emptyState: document.getElementById("emptyState"),
  fileInput: document.getElementById("fileInput"),
  fullscreenButton: document.getElementById("fullscreenButton"),
  generateButton: document.getElementById("generateButton"),
  generationHelp: document.getElementById("generationHelp"),
  generationResult: document.getElementById("generationResult"),
  generationStatus: document.getElementById("generationStatus"),
  generationTool: document.getElementById("generationTool"),
  lightHandle: document.getElementById("lightHandle"),
  loadingState: document.getElementById("loadingState"),
  loadingText: document.getElementById("loadingText"),
  presetGrid: document.getElementById("presetGrid"),
  preview: document.getElementById("preview"),
  previewToolbar: document.getElementById("previewToolbar"),
  refreshButton: document.getElementById("refreshButton"),
  resetButton: document.getElementById("resetButton"),
  sourceSelect: document.getElementById("sourceSelect"),
  sourceSelectShell: document.getElementById("sourceSelectShell"),
  sourceStatus: document.getElementById("sourceStatus"),
  toast: document.getElementById("toast"),
}

const sliderDefinitions = {
  intensity: {
    input: "intensityRange",
    output: "intensityOutput",
    read: (value) => value / 100,
    write: (value) => Math.round(value * 100),
    label: (value) => Math.round(value * 100) + "%",
  },
  softness: {
    input: "softnessRange",
    output: "softnessOutput",
    read: (value) => value / 100,
    write: (value) => Math.round(value * 100),
    label: (value) => Math.round(value * 100) + "%",
  },
  exposure: {
    input: "exposureRange",
    output: "exposureOutput",
    read: (value) => value / 100,
    write: (value) => Math.round(value * 100),
    label: signedPercent,
  },
  temperature: {
    input: "temperatureRange",
    output: "temperatureOutput",
    read: (value) => value / 100,
    write: (value) => Math.round(value * 100),
    label: signedPercent,
  },
  shadows: {
    input: "shadowsRange",
    output: "shadowsOutput",
    read: (value) => value / 100,
    write: (value) => Math.round(value * 100),
    label: (value) => Math.round(value * 100) + "%",
  },
  contrast: {
    input: "contrastRange",
    output: "contrastOutput",
    read: (value) => value / 100,
    write: (value) => Math.round(value * 100),
    label: (value) => Math.round(value * 100) + "%",
  },
  saturation: {
    input: "saturationRange",
    output: "saturationOutput",
    read: (value) => value / 100,
    write: (value) => Math.round(value * 100),
    label: (value) => Math.round(value * 100) + "%",
  },
  vignette: {
    input: "vignetteRange",
    output: "vignetteOutput",
    read: (value) => value / 100,
    write: (value) => Math.round(value * 100),
    label: (value) => Math.round(value * 100) + "%",
  },
}

const renderer = new RelightRenderer(document.getElementById("relightCanvas"))
let settings = copyPreset(PRESETS.cinematic)
let presetId = "cinematic"
let selectedSourceNodeId = null
let selectedGenerationToolId = null
let connectedImages = []
let generationTools = []
let currentSource = { kind: "none" }
let currentBitmap = null
let hostPort = null
let hostReady = false
let generationInFlight = false
let requestSequence = 0
let loadSequence = 0
let refreshPromise = null
let refreshQueued = false
let saveTimer = 0
let saveRevision = 0
let savedRevision = 0
let saveInFlight = null
let saveAttempts = 0
let lastSaveError = null
let renderFrame = 0
let toastTimer = 0
let dragDepth = 0
let lightPointerId = null
const pendingRequests = new Map()

function copyPreset(preset) {
  return {
    ...preset,
    keyColor: [...preset.keyColor],
    shadowColor: [...preset.shadowColor],
    rimColor: [...preset.rimColor],
    showOriginal: false,
  }
}

function signedPercent(value) {
  const percent = Math.round(value * 100)
  return (percent > 0 ? "+" : "") + String(percent) + "%"
}

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value))
}

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
}

function setHidden(element, hidden) {
  element.classList.toggle("is-hidden", hidden)
}

function errorMessage(error, fallback) {
  return error instanceof Error && error.message ? error.message : fallback
}

function showToast(message, kind) {
  window.clearTimeout(toastTimer)
  elements.toast.textContent = message
  elements.toast.dataset.kind = kind || "info"
  setHidden(elements.toast, false)
  toastTimer = window.setTimeout(function () {
    setHidden(elements.toast, true)
  }, 4_500)
}

function setConnectionState(connected) {
  elements.connectionPill.classList.toggle("is-connected", connected)
  elements.connectionText.textContent = connected ? "Canvas 已连接" : "等待宿主"
}

function setLoading(loading, label) {
  if (label) elements.loadingText.textContent = label
  setHidden(elements.loadingState, !loading)
}

function setSourceStatus(value) {
  elements.sourceStatus.textContent = value
}

function scheduleRender() {
  if (renderFrame) return
  renderFrame = window.requestAnimationFrame(function () {
    renderFrame = 0
    renderer.render(currentSource.kind === "none" ? null : settings)
  })
}

function updatePreviewState() {
  const hasSource = currentSource.kind !== "none"
  elements.preview.classList.toggle("has-source", hasSource)
  setHidden(elements.emptyState, hasSource)
  setHidden(elements.lightHandle, !hasSource)
  setHidden(elements.previewToolbar, !hasSource)
  elements.lightHandle.style.left = String(settings.lightX * 100) + "%"
  elements.lightHandle.style.top = String(settings.lightY * 100) + "%"
  elements.preview.classList.toggle("showing-original", settings.showOriginal)
  elements.compareButton.setAttribute("aria-pressed", String(settings.showOriginal))
  elements.compareLabel.textContent = settings.showOriginal ? "查看效果" : "查看原图"
  updateGenerationAvailability()
}

function updateControls() {
  Object.entries(sliderDefinitions).forEach(function ([key, definition]) {
    const input = document.getElementById(definition.input)
    const output = document.getElementById(definition.output)
    input.value = String(definition.write(settings[key]))
    output.value = definition.label(settings[key])
    const minimum = Number(input.min)
    const maximum = Number(input.max)
    const progress = ((Number(input.value) - minimum) / (maximum - minimum)) * 100
    input.style.setProperty("--range-progress", String(progress) + "%")
  })
  elements.presetGrid.querySelectorAll("[data-preset]").forEach(function (button) {
    button.classList.toggle("is-active", button.dataset.preset === presetId)
  })
  updatePreviewState()
}

function applyPreset(nextPresetId, options) {
  const preset = PRESETS[nextPresetId]
  if (!preset) return
  presetId = nextPresetId
  settings = copyPreset(preset)
  updateControls()
  scheduleRender()
  if (!options || options.save !== false) queueStateSave()
}

function markCustom() {
  presetId = "custom"
  updateControls()
  scheduleRender()
  queueStateSave()
}

function snapshotState() {
  return {
    schemaVersion: 1,
    relightProject: {
      version: 1,
      selectedSourceNodeId,
      generation: {
        toolId: selectedGenerationToolId,
        additionalPrompt: elements.additionalPrompt.value.trim(),
      },
      presetId,
      light: {
        x: settings.lightX,
        y: settings.lightY,
        intensity: settings.intensity,
        softness: settings.softness,
        keyColor: [...settings.keyColor],
        shadowColor: [...settings.shadowColor],
        rimColor: [...settings.rimColor],
        rim: settings.rim,
        depth: settings.depth,
      },
      grading: {
        exposure: settings.exposure,
        temperature: settings.temperature,
        shadows: settings.shadows,
        contrast: settings.contrast,
        saturation: settings.saturation,
        vignette: settings.vignette,
      },
    },
  }
}

function finite(value, fallback, minimum, maximum) {
  return typeof value === "number" && Number.isFinite(value) ? clamp(value, minimum, maximum) : fallback
}

function color(value, fallback) {
  if (!Array.isArray(value) || value.length !== 3) return [...fallback]
  return value.map(function (channel, index) {
    return finite(channel, fallback[index], 0, 2)
  })
}

function hydrateState(value) {
  const project = isRecord(value) && isRecord(value.relightProject) ? value.relightProject : null
  if (!project || project.version !== 1) return
  const light = isRecord(project.light) ? project.light : {}
  const grading = isRecord(project.grading) ? project.grading : {}
  const generation = isRecord(project.generation) ? project.generation : {}
  const fallbackPreset = PRESETS[typeof project.presetId === "string" ? project.presetId : ""] || PRESETS.cinematic
  presetId = typeof project.presetId === "string" ? project.presetId : "cinematic"
  if (!PRESETS[presetId] && presetId !== "custom") presetId = "cinematic"
  selectedSourceNodeId = typeof project.selectedSourceNodeId === "string" ? project.selectedSourceNodeId : null
  selectedGenerationToolId = typeof generation.toolId === "string" ? generation.toolId : null
  elements.additionalPrompt.value = typeof generation.additionalPrompt === "string"
    ? generation.additionalPrompt.slice(0, 1_000)
    : ""
  settings = {
    ...settings,
    lightX: finite(light.x, fallbackPreset.lightX, 0.03, 0.97),
    lightY: finite(light.y, fallbackPreset.lightY, 0.03, 0.97),
    intensity: finite(light.intensity, fallbackPreset.intensity, 0, 2),
    softness: finite(light.softness, fallbackPreset.softness, 0.1, 1),
    keyColor: color(light.keyColor, fallbackPreset.keyColor),
    shadowColor: color(light.shadowColor, fallbackPreset.shadowColor),
    rimColor: color(light.rimColor, fallbackPreset.rimColor),
    rim: finite(light.rim, fallbackPreset.rim, 0, 1),
    depth: finite(light.depth, fallbackPreset.depth, 0, 1),
    exposure: finite(grading.exposure, fallbackPreset.exposure, -1, 1),
    temperature: finite(grading.temperature, fallbackPreset.temperature, -1, 1),
    shadows: finite(grading.shadows, fallbackPreset.shadows, 0, 1),
    contrast: finite(grading.contrast, fallbackPreset.contrast, 0.5, 1.5),
    saturation: finite(grading.saturation, fallbackPreset.saturation, 0, 1.6),
    vignette: finite(grading.vignette, fallbackPreset.vignette, 0, 1),
    showOriginal: false,
  }
  updateControls()
}

function queueStateSave() {
  if (!hostReady) return
  saveRevision += 1
  saveAttempts = 0
  lastSaveError = null
  window.clearTimeout(saveTimer)
  if (generationInFlight) return
  saveTimer = window.setTimeout(function () {
    void flushStateSave()
  }, STATE_SAVE_DELAY)
}

async function flushStateSave(options) {
  const allowDuringGeneration = isRecord(options) && options.allowDuringGeneration === true
  window.clearTimeout(saveTimer)
  if (!hostReady || (!allowDuringGeneration && generationInFlight) || savedRevision >= saveRevision) return
  if (saveInFlight) {
    await saveInFlight
    return
  }
  if (saveAttempts >= STATE_SAVE_MAX_ATTEMPTS) return
  const targetRevision = saveRevision
  saveAttempts += 1
  saveInFlight = hostRequest("canvas.node.updateState", { state: snapshotState() })
    .then(function () {
      savedRevision = Math.max(savedRevision, targetRevision)
      saveAttempts = 0
      lastSaveError = null
    })
    .catch(function (error) {
      lastSaveError = error
      if (saveAttempts >= STATE_SAVE_MAX_ATTEMPTS) {
        showToast(errorMessage(error, "光效参数保存失败"), "error")
      }
    })
    .finally(function () {
      saveInFlight = null
      if (!generationInFlight && savedRevision < saveRevision && saveAttempts < STATE_SAVE_MAX_ATTEMPTS) {
        saveTimer = window.setTimeout(
          function () {
            void flushStateSave()
          },
          STATE_SAVE_DELAY * Math.max(1, saveAttempts),
        )
      }
    })
  await saveInFlight
}

async function drainStateSave() {
  while (hostReady && savedRevision < saveRevision) {
    await flushStateSave({ allowDuringGeneration: true })
    if (savedRevision >= saveRevision) return
    if (saveAttempts >= STATE_SAVE_MAX_ATTEMPTS) {
      throw lastSaveError instanceof Error ? lastSaveError : new Error("光效参数保存失败")
    }
  }
}

function postStateSnapshotBestEffort() {
  if (!hostPort || !hostReady || generationInFlight || savedRevision >= saveRevision) return
  try {
    hostPort.postMessage({
      id: PLUGIN_ID + ":close:" + String(++requestSequence),
      method: "canvas.node.updateState",
      params: { state: snapshotState() },
      protocol: HOST_PROTOCOL,
      type: "request",
    })
  } catch {
    // The owning frame may already be gone.
  }
}

function hostRequest(method, params, timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS) {
  if (!hostPort) return Promise.reject(new Error("插件尚未连接宿主"))
  const id = PLUGIN_ID + ":" + String(++requestSequence)
  return new Promise(function (resolve, reject) {
    const timeout = timeoutMs === null
      ? null
      : window.setTimeout(function () {
          pendingRequests.delete(id)
          reject(new Error("宿主请求超时"))
        }, timeoutMs)
    pendingRequests.set(id, { reject, resolve, timeout })
    try {
      hostPort.postMessage({ id, method, ...(params === undefined ? {} : { params }), protocol: HOST_PROTOCOL, type: "request" })
    } catch (error) {
      if (timeout !== null) window.clearTimeout(timeout)
      pendingRequests.delete(id)
      reject(error)
    }
  })
}

function rejectPendingRequests(error) {
  pendingRequests.forEach(function (pending) {
    if (pending.timeout !== null) window.clearTimeout(pending.timeout)
    pending.reject(error)
  })
  pendingRequests.clear()
}

function normalizeConnectedImages(result) {
  if (!isRecord(result) || !Array.isArray(result.images)) return []
  return result.images
    .filter(function (image) {
      return isRecord(image) && typeof image.id === "string" && typeof image.name === "string" && typeof image.readable === "boolean"
    })
    .map(function (image) {
      return { id: image.id, name: image.name, readable: image.readable, mimeType: image.mimeType }
    })
}

function updateSourceSelect() {
  elements.sourceSelect.replaceChildren()
  connectedImages.forEach(function (image) {
    const option = document.createElement("option")
    option.value = image.id
    option.textContent = image.name + (image.readable ? "" : " · 不可读取")
    option.disabled = !image.readable
    elements.sourceSelect.append(option)
  })
  setHidden(elements.sourceSelectShell, connectedImages.length === 0)
  if (currentSource.kind === "canvas") elements.sourceSelect.value = currentSource.nodeId
  else if (selectedSourceNodeId) elements.sourceSelect.value = selectedSourceNodeId
}

function updateGenerationToolSelect() {
  elements.generationTool.replaceChildren()
  if (generationTools.length === 0) {
    const option = document.createElement("option")
    option.value = ""
    option.textContent = "暂无支持参考图的生图模型"
    elements.generationTool.append(option)
    selectedGenerationToolId = null
  } else {
    const selected = generationTools.find((tool) => tool.id === selectedGenerationToolId) || generationTools[0]
    selectedGenerationToolId = selected.id
    generationTools.forEach(function (tool) {
      const option = document.createElement("option")
      option.value = tool.id
      option.textContent = tool.title
      option.title = tool.description
      elements.generationTool.append(option)
    })
    elements.generationTool.value = selected.id
  }
  elements.generationTool.disabled = generationInFlight || generationTools.length === 0
  elements.generationStatus.textContent = generationTools.length ? String(generationTools.length) + " 个可用" : "未找到模型"
  updateGenerationAvailability()
}

function updateGenerationAvailability() {
  if (!elements.generateButton) return
  const tool = generationTools.find((candidate) => candidate.id === selectedGenerationToolId)
  const canvasSource = currentSource.kind === "canvas" && connectedImages.some(function (image) {
    return image.id === currentSource.nodeId && image.readable
  })
  elements.generateButton.disabled = !hostReady || generationInFlight || !tool || !canvasSource
  elements.generateButton.classList.toggle("is-busy", generationInFlight)
  elements.generationTool.disabled = generationInFlight || generationTools.length === 0
  elements.additionalPrompt.disabled = generationInFlight
  if (generationInFlight) {
    elements.generationHelp.textContent = "生成任务正在运行。请保持当前 Canvas、连接和参考图片不变。"
  } else if (currentSource.kind === "local") {
    elements.generationHelp.textContent = "本地图片只用于预览。请把需要生成的 Canvas 图片直接连接到当前插件节点。"
  } else if (!canvasSource) {
    elements.generationHelp.textContent = "需要一张直接连接到当前插件节点的 Canvas 图片。"
  } else if (!tool) {
    elements.generationHelp.textContent = "请先安装并连接一个支持参考图的图像生成插件，然后刷新模型。"
  } else {
    elements.generationHelp.textContent = "将使用“" + tool.title + "”生成；结果会作为新图片节点添加到 Canvas。"
  }
}

async function refreshConnectedImages(forceReload) {
  if (!hostReady) return
  if (refreshPromise) {
    refreshQueued = refreshQueued || forceReload
    return refreshPromise
  }
  refreshPromise = (async function () {
    try {
      connectedImages = normalizeConnectedImages(await hostRequest("canvas.connectedImages.list"))
      updateSourceSelect()
      if (currentSource.kind === "local") {
        setSourceStatus("本地临时图片 · " + currentSource.name + " · 仅预览")
        updateGenerationAvailability()
        return
      }
      const current = currentSource.kind === "canvas"
        ? connectedImages.find(function (image) {
            return image.id === currentSource.nodeId && image.readable
          })
        : null
      const preferred = connectedImages.find(function (image) {
        return image.id === selectedSourceNodeId && image.readable
      })
      const readable = connectedImages.filter(function (image) {
        return image.readable
      })
      const target = current || preferred || readable[readable.length - 1]
      if (target && (forceReload || !current)) await loadConnectedImage(target)
      else if (!target && currentSource.kind === "canvas") clearSource("连接图片已断开")
      else if (!target) setSourceStatus(connectedImages.length ? "连接图片暂不可读取" : "尚未连接 Canvas 图片")
      updateGenerationAvailability()
    } catch (error) {
      showToast(errorMessage(error, "刷新画布连接失败"), "error")
    }
  })()
  try {
    await refreshPromise
  } finally {
    refreshPromise = null
    if (refreshQueued) {
      refreshQueued = false
      window.queueMicrotask(function () {
        void refreshConnectedImages(true)
      })
    }
  }
}

async function refreshGenerationTools() {
  if (!hostReady || generationInFlight) return
  elements.generationStatus.textContent = "正在读取模型…"
  try {
    generationTools = normalizeGenerationTools(await hostRequest("generation.tools.list", { output: "image" }))
    updateGenerationToolSelect()
  } catch (error) {
    generationTools = []
    updateGenerationToolSelect()
    showToast(errorMessage(error, "读取生成模型失败"), "error")
  }
}

function dataUrlBlob(dataUrl, expectedMimeType) {
  const match = /^data:([^;,]+);base64,([A-Za-z0-9+/]*={0,2})$/i.exec(dataUrl)
  if (!match || match[1].toLowerCase() !== expectedMimeType.toLowerCase()) throw new Error("宿主返回了无效图片")
  const decoded = window.atob(match[2])
  if (decoded.length > MAX_IMAGE_FILE_BYTES) throw new Error("图片超过 16 MiB 限制")
  const bytes = new Uint8Array(decoded.length)
  for (let index = 0; index < decoded.length; index += 1) bytes[index] = decoded.charCodeAt(index)
  return new Blob([bytes], { type: expectedMimeType })
}

async function decodeImage(blob) {
  const bitmap = await createImageBitmap(blob)
  if (!bitmap.width || !bitmap.height || bitmap.width * bitmap.height > MAX_IMAGE_PIXELS) {
    bitmap.close()
    throw new Error("图片尺寸过大，最多支持 4000 万像素")
  }
  return bitmap
}

function replaceBitmap(bitmap, source) {
  if (currentBitmap) currentBitmap.close()
  currentBitmap = bitmap
  currentSource = source
  renderer.setSource(bitmap, { width: bitmap.width, height: bitmap.height }, "image")
  updatePreviewState()
  scheduleRender()
}

async function loadConnectedImage(image) {
  const sequence = ++loadSequence
  setLoading(true, "正在读取画布图片…")
  try {
    const result = await hostRequest("canvas.connectedImage.read", { nodeId: image.id })
    if (sequence !== loadSequence) return
    if (
      !isRecord(result) ||
      typeof result.dataUrl !== "string" ||
      typeof result.mimeType !== "string" ||
      !ACCEPTED_IMAGE_TYPES.has(result.mimeType.toLowerCase())
    ) throw new Error("宿主没有返回可用图片")
    const bitmap = await decodeImage(dataUrlBlob(result.dataUrl, result.mimeType))
    if (sequence !== loadSequence) {
      bitmap.close()
      return
    }
    const name = typeof result.name === "string" ? result.name : image.name
    replaceBitmap(bitmap, { kind: "canvas", name, nodeId: image.id })
    selectedSourceNodeId = image.id
    updateSourceSelect()
    setSourceStatus("Canvas · " + name + " · " + String(bitmap.width) + "×" + String(bitmap.height))
    queueStateSave()
  } catch (error) {
    if (sequence === loadSequence) showToast(errorMessage(error, "画布图片载入失败"), "error")
  } finally {
    if (sequence === loadSequence) setLoading(false)
    updateGenerationAvailability()
  }
}

async function loadLocalImage(file) {
  if (!file || !ACCEPTED_IMAGE_TYPES.has(file.type)) {
    showToast("请选择 JPEG、PNG 或 WebP 图片。", "error")
    return
  }
  if (!Number.isSafeInteger(file.size) || file.size < 1 || file.size > MAX_IMAGE_FILE_BYTES) {
    showToast("本地图片必须小于或等于 16 MiB。", "error")
    return
  }
  const sequence = ++loadSequence
  setLoading(true, "正在解码本地图片…")
  try {
    const bitmap = await decodeImage(file)
    if (sequence !== loadSequence) {
      bitmap.close()
      return
    }
    replaceBitmap(bitmap, { kind: "local", name: file.name })
    setSourceStatus("本地临时图片 · " + file.name + " · " + String(bitmap.width) + "×" + String(bitmap.height) + " · 仅预览")
  } catch (error) {
    if (sequence === loadSequence) showToast(errorMessage(error, "本地图片载入失败"), "error")
  } finally {
    if (sequence === loadSequence) setLoading(false)
    updateGenerationAvailability()
  }
}

function clearSource(status) {
  loadSequence += 1
  if (currentBitmap) currentBitmap.close()
  currentBitmap = null
  currentSource = { kind: "none" }
  renderer.clearSource()
  setSourceStatus(status || "尚未载入")
  updatePreviewState()
}

function handleHostMessage(event) {
  const message = event.data
  if (!isRecord(message) || message.protocol !== HOST_PROTOCOL) return
  if (message.type === "response" && typeof message.id === "string") {
    const pending = pendingRequests.get(message.id)
    if (!pending) return
    if (pending.timeout !== null) window.clearTimeout(pending.timeout)
    pendingRequests.delete(message.id)
    if (message.ok === true) pending.resolve(message.result)
    else pending.reject(new Error(typeof message.error === "string" ? message.error : "宿主请求失败"))
    return
  }
  if (message.type !== "command" || typeof message.command !== "string") return
  if (message.command === CONNECTED_IMAGES_CHANGED || message.command === "relight.refresh-connections") {
    void refreshConnectedImages(true)
    void refreshGenerationTools()
  } else if (message.command === "relight.compare") {
    toggleComparison()
  } else if (message.command === "relight.reset") {
    applyPreset("cinematic")
  }
}

async function initializeHost() {
  try {
    const context = await hostRequest("host.context.get")
    const metadata = isRecord(context) && isRecord(context.node) && isRecord(context.node.data)
      ? context.node.data.metadata
      : null
    const state = isRecord(metadata) ? metadata.convaxPluginState : null
    hydrateState(state)
    hostReady = true
    setConnectionState(true)
    await Promise.all([refreshConnectedImages(false), refreshGenerationTools()])
  } catch (error) {
    showToast(errorMessage(error, "无法连接 Convax 宿主"), "error")
  }
}

function handleWindowMessage(event) {
  const message = event.data
  if (
    event.source !== window.parent ||
    hostPort ||
    !isRecord(message) ||
    message.protocol !== HOST_PROTOCOL ||
    message.type !== "connect" ||
    message.pluginId !== PLUGIN_ID ||
    event.ports.length !== 1
  ) return
  window.removeEventListener("message", handleWindowMessage)
  hostPort = event.ports[0]
  hostPort.onmessage = handleHostMessage
  hostPort.start()
  void initializeHost()
}

function toggleComparison() {
  if (currentSource.kind === "none") return
  settings.showOriginal = !settings.showOriginal
  updatePreviewState()
  scheduleRender()
}

function updateLightFromEvent(event) {
  const bounds = elements.preview.getBoundingClientRect()
  settings.lightX = clamp((event.clientX - bounds.left) / bounds.width, 0.03, 0.97)
  settings.lightY = clamp((event.clientY - bounds.top) / bounds.height, 0.03, 0.97)
  presetId = "custom"
  updateControls()
  scheduleRender()
}

function openFilePicker() {
  elements.fileInput.click()
}

async function toggleFullscreen() {
  try {
    if (document.fullscreenElement) await document.exitFullscreen()
    else await document.documentElement.requestFullscreen()
  } catch (error) {
    showToast(errorMessage(error, "宿主或系统未允许全屏预览"), "error")
  }
}

function updateFullscreenState() {
  document.documentElement.classList.toggle("is-fullscreen", Boolean(document.fullscreenElement))
}

function lightPositionDescription(x, y) {
  const horizontal = x < 0.38 ? "左侧" : x > 0.62 ? "右侧" : "中央"
  const vertical = y < 0.38 ? "上方" : y > 0.62 ? "下方" : "平视高度"
  return vertical + horizontal
}

function percent(value) {
  return String(Math.round(value * 100)) + "%"
}

function buildRelightPrompt() {
  const additional = elements.additionalPrompt.value.trim()
  const lines = [
    "请对参考图片进行专业重打光，只改变光照、阴影、色调与整体氛围。",
    "严格保留主体身份、面部特征、姿态、构图、镜头视角、景别、背景结构、产品几何、材质、纹理、已有文字与标志；不要新增、删除、移动或替换对象，不要裁切或改变画幅。",
    "灯光风格：" + (PRESET_PROMPTS[presetId] || PRESET_PROMPTS.custom) + "。",
    "主光位置：画面" + lightPositionDescription(settings.lightX, settings.lightY) +
      "（水平 " + percent(settings.lightX) + "，垂直 " + percent(settings.lightY) + "）；主光强度 " +
      percent(settings.intensity) + "；柔和度 " + percent(settings.softness) + "。",
    "曝光调整 " + signedPercent(settings.exposure) + "；色温 " + signedPercent(settings.temperature) +
      "；暗部抬升 " + percent(settings.shadows) + "；对比度 " + percent(settings.contrast) +
      "；饱和度 " + percent(settings.saturation) + "；暗角 " + percent(settings.vignette) + "。",
    "让光向、遮挡、接触阴影、反射和轮廓光连续可信，保留皮肤、织物、金属、玻璃等原始材质细节，避免塑料感、过曝光斑、脏污色块和不自然边缘。",
  ]
  if (additional) lines.push("补充要求：" + additional)
  return lines.join("\n")
}

function validGenerationResult(value) {
  return isRecord(value) &&
    Array.isArray(value.createdNodeIds) && value.createdNodeIds.length > 0 &&
    value.createdNodeIds.every((id) => typeof id === "string" && id.length > 0) &&
    Number.isSafeInteger(value.revision) && value.revision >= 0 &&
    typeof value.toolId === "string" && value.toolId.length > 0 &&
    Array.isArray(value.warnings)
}

async function generateRelight() {
  if (generationInFlight) return
  const tool = generationTools.find((candidate) => candidate.id === selectedGenerationToolId)
  if (!tool) {
    showToast("没有可用的参考图生成模型。", "error")
    return
  }
  if (currentSource.kind !== "canvas") {
    showToast("请先选择一张直接连接的 Canvas 图片；本地图片只能预览。", "error")
    return
  }
  const image = connectedImages.find((candidate) => candidate.id === currentSource.nodeId && candidate.readable)
  if (!image) {
    showToast("当前 Canvas 图片已断开或不可读取。", "error")
    return
  }
  generationInFlight = true
  setHidden(elements.generationResult, true)
  elements.generationStatus.textContent = "生成中"
  updateGenerationAvailability()
  queueStateSave()
  try {
    await drainStateSave()
    const result = await hostRequest(
      "generation.canvas.execute",
      buildRelightGenerationRequest({
        prompt: buildRelightPrompt(),
        referenceNodeId: image.id,
        toolId: tool.id,
      }),
      null,
    )
    if (!validGenerationResult(result)) throw new Error("宿主返回了无效生成结果")
    const count = result.createdNodeIds.length
    elements.generationResult.textContent = "已生成 " + String(count) + " 张图片到 Canvas（revision " + String(result.revision) + "）。"
    elements.generationResult.dataset.kind = "success"
    setHidden(elements.generationResult, false)
    result.warnings.filter((warning) => typeof warning === "string").forEach(function (warning) {
      showToast(warning, "warning")
    })
  } catch (error) {
    elements.generationResult.textContent = errorMessage(error, "重打光图片生成失败")
    elements.generationResult.dataset.kind = "error"
    setHidden(elements.generationResult, false)
  } finally {
    generationInFlight = false
    elements.generationStatus.textContent = generationTools.length ? String(generationTools.length) + " 个可用" : "未找到模型"
    updateGenerationAvailability()
    void flushStateSave()
  }
}

function bindControls() {
  Object.entries(sliderDefinitions).forEach(function ([key, definition]) {
    const input = document.getElementById(definition.input)
    input.addEventListener("input", function () {
      settings[key] = definition.read(Number(input.value))
      markCustom()
    })
    input.addEventListener("change", function () {
      void flushStateSave()
    })
  })
  elements.presetGrid.addEventListener("click", function (event) {
    const button = event.target.closest("[data-preset]")
    if (button) applyPreset(button.dataset.preset)
  })
  elements.resetButton.addEventListener("click", function () {
    applyPreset("cinematic")
  })
  elements.compareButton.addEventListener("click", toggleComparison)
  elements.refreshButton.addEventListener("click", function () {
    void refreshConnectedImages(true)
    void refreshGenerationTools()
  })
  elements.fullscreenButton.addEventListener("click", function () {
    void toggleFullscreen()
  })
  elements.chooseButton.addEventListener("click", openFilePicker)
  elements.emptyChooseButton.addEventListener("click", openFilePicker)
  elements.fileInput.addEventListener("change", function () {
    const file = elements.fileInput.files && elements.fileInput.files[0]
    elements.fileInput.value = ""
    if (file) void loadLocalImage(file)
  })
  elements.sourceSelect.addEventListener("change", function () {
    const image = connectedImages.find(function (candidate) {
      return candidate.id === elements.sourceSelect.value && candidate.readable
    })
    if (image) void loadConnectedImage(image)
  })
  elements.generationTool.addEventListener("change", function () {
    const tool = generationTools.find((candidate) => candidate.id === elements.generationTool.value)
    selectedGenerationToolId = tool ? tool.id : null
    queueStateSave()
    updateGenerationAvailability()
  })
  elements.additionalPrompt.addEventListener("input", queueStateSave)
  elements.additionalPrompt.addEventListener("change", function () {
    void flushStateSave()
  })
  elements.generateButton.addEventListener("click", function () {
    void generateRelight()
  })

  elements.lightHandle.addEventListener("pointerdown", function (event) {
    if (event.button !== 0) return
    lightPointerId = event.pointerId
    elements.lightHandle.setPointerCapture(event.pointerId)
    elements.lightHandle.classList.add("is-dragging")
    updateLightFromEvent(event)
  })
  elements.lightHandle.addEventListener("pointermove", function (event) {
    if (lightPointerId === event.pointerId) updateLightFromEvent(event)
  })
  function finishLightDrag(event) {
    if (lightPointerId !== event.pointerId) return
    lightPointerId = null
    elements.lightHandle.classList.remove("is-dragging")
    queueStateSave()
    void flushStateSave()
  }
  elements.lightHandle.addEventListener("pointerup", finishLightDrag)
  elements.lightHandle.addEventListener("pointercancel", finishLightDrag)
  elements.lightHandle.addEventListener("keydown", function (event) {
    const step = event.shiftKey ? 0.05 : 0.015
    if (event.key === "ArrowLeft") settings.lightX = clamp(settings.lightX - step, 0.03, 0.97)
    else if (event.key === "ArrowRight") settings.lightX = clamp(settings.lightX + step, 0.03, 0.97)
    else if (event.key === "ArrowUp") settings.lightY = clamp(settings.lightY - step, 0.03, 0.97)
    else if (event.key === "ArrowDown") settings.lightY = clamp(settings.lightY + step, 0.03, 0.97)
    else return
    event.preventDefault()
    markCustom()
  })

  elements.preview.addEventListener("dragenter", function (event) {
    event.preventDefault()
    dragDepth += 1
    setHidden(elements.dragHint, false)
  })
  elements.preview.addEventListener("dragover", function (event) {
    event.preventDefault()
  })
  elements.preview.addEventListener("dragleave", function (event) {
    event.preventDefault()
    dragDepth = Math.max(0, dragDepth - 1)
    if (!dragDepth) setHidden(elements.dragHint, true)
  })
  elements.preview.addEventListener("drop", function (event) {
    event.preventDefault()
    dragDepth = 0
    setHidden(elements.dragHint, true)
    const file = Array.from(event.dataTransfer.files || []).find(function (candidate) {
      return ACCEPTED_IMAGE_TYPES.has(candidate.type)
    })
    if (file) void loadLocalImage(file)
    else showToast("拖入内容中没有可用的 JPEG、PNG 或 WebP 图片。", "error")
  })
  document.addEventListener("fullscreenchange", updateFullscreenState)
}

function bindLifecycle() {
  window.addEventListener("message", handleWindowMessage)
  window.addEventListener("beforeunload", function () {
    postStateSnapshotBestEffort()
    window.clearTimeout(saveTimer)
    window.clearTimeout(toastTimer)
    if (renderFrame) window.cancelAnimationFrame(renderFrame)
    rejectPendingRequests(new Error("插件页面已关闭"))
    if (hostPort) {
      hostPort.onmessage = null
      hostPort.close()
      hostPort = null
    }
    if (currentBitmap) currentBitmap.close()
  })
  const canvas = renderer.canvas
  canvas.addEventListener("webglcontextlost", function (event) {
    event.preventDefault()
    renderer.contextState = "lost"
    setLoading(true, "图形上下文恢复中…")
  })
  canvas.addEventListener("webglcontextrestored", function () {
    try {
      renderer.initialize()
      if (currentBitmap) renderer.setSource(currentBitmap, { width: currentBitmap.width, height: currentBitmap.height }, "image")
      setLoading(false)
      scheduleRender()
    } catch (error) {
      showToast(errorMessage(error, "WebGL 恢复失败"), "error")
    }
  })
  const resizeObserver = new ResizeObserver(scheduleRender)
  resizeObserver.observe(elements.preview)
}

function boot() {
  bindControls()
  bindLifecycle()
  updateControls()
  updatePreviewState()
  setConnectionState(false)
  setSourceStatus("尚未连接 Canvas 图片")
  updateGenerationToolSelect()
  try {
    renderer.initialize()
    scheduleRender()
  } catch (error) {
    elements.emptyState.querySelector("h1").textContent = "WebGL2 不可用"
    elements.emptyState.querySelector("p").textContent = errorMessage(error, "无法初始化重打光预览")
    elements.emptyChooseButton.disabled = true
    elements.chooseButton.disabled = true
  }
}

boot()
