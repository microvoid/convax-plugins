export type SubtitleStreamKind = "embedded" | "sidecar"

export interface SubtitleAudioStreamDescriptor {
  codec: string
  default: boolean
  index: number
  language?: string
  title?: string
}

export interface SubtitleStreamDescriptor {
  codec: string
  default: boolean
  forced: boolean
  index: number
  kind: SubtitleStreamKind
  language?: string
  title?: string
}

export interface SubtitleMediaInspection {
  audioStreams: SubtitleAudioStreamDescriptor[]
  durationMs: number
  height: number
  subtitleStreams: SubtitleStreamDescriptor[]
  width: number
}

export interface NormalizedSubtitleRegion {
  height: number
  width: number
  x: number
  y: number
}

export interface PixelSubtitleRegion {
  height: number
  width: number
  x: number
  y: number
}

export interface SoftSubtitleErasePlan {
  mode: "soft"
  removeStreamIndexes: number[]
}

export interface HardSubtitleErasePlan {
  mode: "hard"
  region: NormalizedSubtitleRegion
}

function requireDimension(value: unknown, label: string) {
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > 131_072) {
    throw new Error(`${label} must be a positive integer`)
  }
  return value as number
}

function requireUnit(value: unknown, label: string) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(`${label} must be between 0 and 1`)
  }
  return value
}

export function validateSubtitleMediaInspection(value: SubtitleMediaInspection): SubtitleMediaInspection {
  const width = requireDimension(value.width, "Media width")
  const height = requireDimension(value.height, "Media height")
  if (!Number.isSafeInteger(value.durationMs) || value.durationMs < 0) {
    throw new Error("Media duration must be a non-negative integer")
  }
  if (!Array.isArray(value.audioStreams) || value.audioStreams.length > 256) {
    throw new Error("Audio stream list is invalid")
  }
  const audioIndexes = new Set<number>()
  const audioStreams = value.audioStreams.map((stream) => {
    if (!stream || typeof stream !== "object") throw new Error("Audio stream must be an object")
    if (!Number.isSafeInteger(stream.index) || stream.index < 0 || audioIndexes.has(stream.index)) {
      throw new Error("Audio stream indexes must be unique non-negative integers")
    }
    if (typeof stream.codec !== "string" || !stream.codec.trim() || stream.codec.length > 128) {
      throw new Error("Audio stream codec is invalid")
    }
    if (typeof stream.default !== "boolean") throw new Error("Audio stream disposition is invalid")
    audioIndexes.add(stream.index)
    return { ...stream }
  })
  if (!Array.isArray(value.subtitleStreams) || value.subtitleStreams.length > 256) {
    throw new Error("Subtitle stream list is invalid")
  }
  const indexes = new Set<number>()
  const subtitleStreams = value.subtitleStreams.map((stream) => {
    if (!stream || typeof stream !== "object") throw new Error("Subtitle stream must be an object")
    if (!Number.isSafeInteger(stream.index) || stream.index < 0 || indexes.has(stream.index)) {
      throw new Error("Subtitle stream indexes must be unique non-negative integers")
    }
    if (stream.kind !== "embedded" && stream.kind !== "sidecar") throw new Error("Subtitle stream kind is invalid")
    if (typeof stream.codec !== "string" || !stream.codec.trim() || stream.codec.length > 128) {
      throw new Error("Subtitle stream codec is invalid")
    }
    if (typeof stream.default !== "boolean" || typeof stream.forced !== "boolean") {
      throw new Error("Subtitle stream disposition is invalid")
    }
    indexes.add(stream.index)
    return { ...stream }
  })
  return { audioStreams, durationMs: value.durationMs, height, subtitleStreams, width }
}

export function selectTranscriptionAudioStream(inspection: SubtitleMediaInspection): SubtitleAudioStreamDescriptor {
  const streams = [...validateSubtitleMediaInspection(inspection).audioStreams].sort(
    (left, right) => left.index - right.index,
  )
  if (streams.length === 0) throw new Error("Connected video does not contain a transcribable audio track")
  return streams.find((stream) => stream.default) ?? streams[0]!
}

export function createSoftSubtitleErasePlan(
  inspection: SubtitleMediaInspection,
  streamIndexes: readonly number[] | "all",
): SoftSubtitleErasePlan {
  const parsed = validateSubtitleMediaInspection(inspection)
  const embedded = parsed.subtitleStreams.filter((stream) => stream.kind === "embedded")
  const requested = streamIndexes === "all" ? embedded.map((stream) => stream.index) : [...streamIndexes]
  if (requested.length === 0) throw new Error("Select at least one embedded subtitle stream to remove")
  if (new Set(requested).size !== requested.length) throw new Error("Subtitle erase stream indexes must be unique")
  const available = new Set(embedded.map((stream) => stream.index))
  const unavailable = requested.find((index) => !Number.isSafeInteger(index) || !available.has(index))
  if (unavailable !== undefined)
    throw new Error(`Subtitle stream is not available for embedded removal: ${unavailable}`)
  return { mode: "soft", removeStreamIndexes: requested.sort((left, right) => left - right) }
}

export function validateNormalizedSubtitleRegion(value: NormalizedSubtitleRegion): NormalizedSubtitleRegion {
  const region = {
    height: requireUnit(value.height, "Subtitle region height"),
    width: requireUnit(value.width, "Subtitle region width"),
    x: requireUnit(value.x, "Subtitle region x"),
    y: requireUnit(value.y, "Subtitle region y"),
  }
  if (region.width <= 0 || region.height <= 0) throw new Error("Subtitle region must have a positive size")
  if (region.x + region.width > 1 + Number.EPSILON || region.y + region.height > 1 + Number.EPSILON) {
    throw new Error("Subtitle region must stay inside the video frame")
  }
  return region
}

export function createHardSubtitleErasePlan(region: NormalizedSubtitleRegion): HardSubtitleErasePlan {
  return { mode: "hard", region: validateNormalizedSubtitleRegion(region) }
}

export function normalizedSubtitleRegionToPixels(
  region: NormalizedSubtitleRegion,
  dimensions: { height: number; width: number },
): PixelSubtitleRegion {
  const normalized = validateNormalizedSubtitleRegion(region)
  const frameWidth = requireDimension(dimensions.width, "Media width")
  const frameHeight = requireDimension(dimensions.height, "Media height")
  const x = Math.min(frameWidth - 2, Math.max(0, Math.floor(normalized.x * frameWidth)))
  const y = Math.min(frameHeight - 2, Math.max(0, Math.floor(normalized.y * frameHeight)))
  const width = Math.max(2, Math.min(frameWidth - x, Math.ceil(normalized.width * frameWidth)))
  const height = Math.max(2, Math.min(frameHeight - y, Math.ceil(normalized.height * frameHeight)))
  return { height, width, x, y }
}

export function defaultHardSubtitleRegion(): NormalizedSubtitleRegion {
  return { height: 0.22, width: 0.9, x: 0.05, y: 0.73 }
}
