export const MAX_SELECTED_PRESETS = 6
export const MIN_SELECTED_PRESETS = 2
export const STATE_SCHEMA_VERSION = 3

export const ANGLE_PRESETS = Object.freeze([
  { id: "front", label: "正面", shortLabel: "Front", prompt: "eye-level front view, camera centered on the subject" },
  { id: "three-quarter", label: "左前 3/4", shortLabel: "3/4", prompt: "left-front three-quarter view with clear depth and silhouette" },
  { id: "left", label: "左侧", shortLabel: "Left", prompt: "true left profile view at the same subject scale" },
  { id: "right", label: "右侧", shortLabel: "Right", prompt: "true right profile view at the same subject scale" },
  { id: "back", label: "背面", shortLabel: "Back", prompt: "straight rear view showing the back design clearly" },
  { id: "top", label: "俯视", shortLabel: "Top", prompt: "high top-down view while preserving recognizable proportions" },
  { id: "low", label: "低机位", shortLabel: "Low", prompt: "low-angle hero view with restrained perspective distortion" },
  { id: "cinematic", label: "电影感", shortLabel: "Cinematic", prompt: "cinematic three-quarter view with intentional depth and composition" },
])

export const SUBJECT_TYPES = Object.freeze([
  { id: "character", label: "人物 / 角色", prompt: "白底角色设定图", subject: "角色" },
  { id: "product", label: "产品 / 物件", prompt: "干净棚拍背景的产品设定图", subject: "产品或物件" },
  { id: "scene", label: "场景 / 空间", prompt: "统一画风的场景概念设定图", subject: "场景或空间" },
])

const DEFAULT_PRESET_IDS = ["front", "left", "top", "cinematic"]
const PRESET_IDS = new Set(ANGLE_PRESETS.map((preset) => preset.id))
const SUBJECT_IDS = new Set(SUBJECT_TYPES.map((subject) => subject.id))
const TERMINAL_RUN_STATUSES = new Set(["success", "failed", "interrupted"])

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
}

function safeText(value, maximum = 1000) {
  return typeof value === "string" ? value.slice(0, maximum) : ""
}

function safeId(value, maximum = 512) {
  return typeof value === "string" && value.length > 0 && value.length <= maximum
    && !/[\u0000-\u001f\u007f]/u.test(value)
    ? value
    : null
}

function uniquePresetIds(value) {
  if (!Array.isArray(value)) return []
  return [...new Set(value.filter((item) => safeId(item) && PRESET_IDS.has(item)))].slice(0, MAX_SELECTED_PRESETS)
}

function normalizedWarnings(value) {
  if (!Array.isArray(value)) return []
  return value
    .filter((warning) => typeof warning === "string" && warning.length > 0)
    .slice(0, 32)
    .map((warning) => warning.slice(0, 2000))
}

function normalizedNodeIds(value) {
  if (!Array.isArray(value)) return []
  return [...new Set(value.map((id) => safeId(id)).filter(Boolean))].slice(0, 32)
}

export function presetById(id) {
  return ANGLE_PRESETS.find((preset) => preset.id === id) ?? null
}

export function createDefaultState() {
  return {
    lastRun: null,
    notes: "",
    result: null,
    schemaVersion: STATE_SCHEMA_VERSION,
    selectedPresetIds: [...DEFAULT_PRESET_IDS],
    sourceNodeId: null,
    subjectType: "character",
    toolId: null,
  }
}

export function normalizeGenerationResult(value, presetIds, completedAt) {
  const normalizedPresetIds = uniquePresetIds(presetIds)
  if (!isRecord(value) || normalizedPresetIds.length < MIN_SELECTED_PRESETS) throw new Error("生成结果无效")
  const createdNodeIds = normalizedNodeIds(value.createdNodeIds)
  const toolId = safeId(value.toolId, 256)
  if (createdNodeIds.length === 0 || !toolId || !Number.isSafeInteger(value.revision) || value.revision < 0) {
    throw new Error("生成结果无效")
  }
  return {
    completedAt: safeText(completedAt, 64),
    createdNodeIds,
    presetIds: normalizedPresetIds,
    revision: value.revision,
    toolId,
    warnings: normalizedWarnings(value.warnings),
  }
}

function normalizePersistedResult(value) {
  if (!isRecord(value)) return null
  try {
    return normalizeGenerationResult(value, value.presetIds, value.completedAt)
  } catch {
    return null
  }
}

function normalizeFailure(value) {
  if (!isRecord(value)) return null
  const message = safeText(value.message, 280)
  return message ? { message } : null
}

function normalizeLastRun(value) {
  if (!isRecord(value)) return null
  const presetIds = uniquePresetIds(value.presetIds)
  const sourceNodeId = safeId(value.sourceNodeId)
  const toolId = safeId(value.toolId, 256)
  if (presetIds.length < MIN_SELECTED_PRESETS || !sourceNodeId || !toolId) return null
  if (value.status === "running") {
    return {
      completedAt: "",
      failure: { message: "插件页面在宫格图生成完成前关闭。宿主会保留已提交的 Canvas 结果。" },
      presetIds,
      sourceNodeId,
      startedAt: safeText(value.startedAt, 64),
      status: "interrupted",
      toolId,
    }
  }
  if (!TERMINAL_RUN_STATUSES.has(value.status)) return null
  return {
    completedAt: safeText(value.completedAt, 64),
    failure: normalizeFailure(value.failure),
    presetIds,
    sourceNodeId,
    startedAt: safeText(value.startedAt, 64),
    status: value.status,
    toolId,
  }
}

function hydrateCurrentState(value) {
  const fallback = createDefaultState()
  const selectedPresetIds = uniquePresetIds(value.selectedPresetIds)
  return {
    lastRun: normalizeLastRun(value.lastRun),
    notes: safeText(value.notes, 1000),
    result: normalizePersistedResult(value.result),
    schemaVersion: STATE_SCHEMA_VERSION,
    selectedPresetIds: selectedPresetIds.length ? selectedPresetIds : fallback.selectedPresetIds,
    sourceNodeId: safeId(value.sourceNodeId),
    subjectType: SUBJECT_IDS.has(value.subjectType) ? value.subjectType : fallback.subjectType,
    toolId: safeId(value.toolId, 256),
  }
}

function migrateLegacyState(value) {
  const fallback = createDefaultState()
  const selectedPresetIds = uniquePresetIds(value.selectedPresetIds)
  return {
    ...fallback,
    notes: safeText(value.notes, 1000),
    selectedPresetIds: selectedPresetIds.length ? selectedPresetIds : fallback.selectedPresetIds,
    sourceNodeId: safeId(value.sourceNodeId),
    subjectType: SUBJECT_IDS.has(value.subjectType) ? value.subjectType : fallback.subjectType,
    toolId: safeId(value.toolId, 256),
  }
}

export function hydratePluginState(value) {
  if (value === null || value === undefined) return { source: "empty", state: createDefaultState() }
  if (!isRecord(value)) return { source: "unsupported", state: createDefaultState() }
  if (value.schemaVersion === STATE_SCHEMA_VERSION) return { source: "current", state: hydrateCurrentState(value) }
  if (value.schemaVersion === 1 || value.schemaVersion === 2) {
    return { source: "legacy", state: migrateLegacyState(value) }
  }
  return { source: "unsupported", state: createDefaultState() }
}

export function normalizeGenerationTools(value) {
  if (!isRecord(value) || !Array.isArray(value.tools)) return []
  const seen = new Set()
  const tools = []
  for (const candidate of value.tools) {
    if (!isRecord(candidate) || candidate.kind !== "model" || candidate.output !== "image") continue
    if (!Array.isArray(candidate.acceptedInputs) || !candidate.acceptedInputs.includes("reference_image")) continue
    const id = safeId(candidate.id, 256)
    const title = safeText(candidate.title, 120)
    if (!id || !title || seen.has(id)) continue
    seen.add(id)
    tools.push({
      acceptedInputs: [...new Set(candidate.acceptedInputs.filter((role) => typeof role === "string"))],
      description: safeText(candidate.description, 2000),
      id,
      kind: "model",
      output: "image",
      title,
    })
  }
  return tools
}

function gridLayout(count) {
  if (count === 2) return "1 行 × 2 列"
  if (count === 3) return "1 行 × 3 列"
  if (count === 4) return "2 行 × 2 列"
  if (count === 5) return "2 行布局（第一行 3 格，第二行 2 格居中）"
  if (count === 6) return "2 行 × 3 列"
  return "等分宫格"
}

export function createMultiAngleGridPrompt(input) {
  const presetIds = uniquePresetIds(input.presetIds)
  const subject = SUBJECT_TYPES.find((item) => item.id === input.subjectType)
  if (presetIds.length < MIN_SELECTED_PRESETS || !subject) throw new Error("镜头方案无效")
  const presets = presetIds.map((presetId) => presetById(presetId))
  if (presets.some((preset) => !preset)) throw new Error("镜头方案无效")
  const notes = safeText(input.notes, 1000).trim()
  return [
    `严格基于参考图中的同一主体，生成一张标准${subject.prompt}。`,
    `最终只输出一张图片，采用${gridLayout(presets.length)}的${presets.length}宫格；各格尺寸一致、边界清晰、构图整齐。`,
    "按从左到右、从上到下的阅读顺序，每个格子只展示同一主体的一个视角：",
    ...presets.map((preset, index) => `第 ${index + 1} 格：${preset.label}（${preset.prompt}）。`),
    `每个格子只出现一个完整的${subject.subject}，保持相近景别、主体比例和视觉重心。`,
    "参考图是主体身份、轮廓、比例、五官或结构、发型、服饰或材质、颜色、标志性细节与画风的唯一依据；只改变观察机位，谨慎推断新露出的表面。",
    "所有格子中的主体必须完全一致，光线逻辑、背景风格与镜头质感保持统一；不同格子不得变成不同人物、不同产品或不同场景。",
    "不要把视角拆成多张图片，不要在单个格子中重复主体，不要增加未选择的视角，也不要生成文字标签、标题、说明、边框文字、水印、Logo 或 UI。",
    "这是一张多角度视觉一致性设定图，不代表几何精确的真实 3D 或工业 CAD 重建。",
    ...(notes ? [`额外一致性要求：${notes}`] : []),
  ].join("\n")
}

export function createGenerationRequest(input) {
  const sourceNodeId = safeId(input.sourceNodeId)
  const toolId = safeId(input.toolId, 256)
  const prompt = safeText(input.prompt, 20_000).trim()
  if (!sourceNodeId || !toolId || !prompt) throw new Error("生成请求无效")
  return {
    output: "image",
    prompt,
    references: [{ nodeId: sourceNodeId, role: "reference_image" }],
    resultMode: "create-pending-node",
    toolId,
  }
}

function failureMessage(error) {
  return safeText(error instanceof Error ? error.message : "Canvas generation could not be completed", 280)
    || "Canvas generation could not be completed"
}

export async function executeGridGeneration(input) {
  try {
    return { failure: null, result: await input.execute() }
  } catch (error) {
    return { failure: { message: failureMessage(error) }, result: null }
  }
}
