import {
  canonicalSubtitleLanguage,
  parseSubtitleTrack,
  validateSubtitleMediaInspection,
  type SubtitleMediaInspection,
} from "../domain"

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
}

export function parseFfprobeInspection(value: string): SubtitleMediaInspection {
  let parsed: unknown
  try {
    parsed = JSON.parse(value)
  } catch {
    throw new Error("Media probe returned invalid JSON")
  }
  if (!isRecord(parsed) || !Array.isArray(parsed.streams)) throw new Error("Media probe did not return streams")
  const streams = parsed.streams.filter(isRecord)
  const video = streams.find((stream) => stream.codec_type === "video")
  if (!video) throw new Error("Connected media does not contain video")
  const durationSeconds = isRecord(parsed.format) ? Number(parsed.format.duration) : Number.NaN
  return validateSubtitleMediaInspection({
    audioStreams: streams
      .filter((stream) => stream.codec_type === "audio")
      .map((stream) => {
        const disposition = isRecord(stream.disposition) ? stream.disposition : {}
        const tags = isRecord(stream.tags) ? stream.tags : {}
        return {
          codec: typeof stream.codec_name === "string" ? stream.codec_name : "unknown",
          default: disposition.default === 1,
          index: Number(stream.index),
          ...(typeof tags.language === "string" ? { language: tags.language } : {}),
          ...(typeof tags.title === "string" ? { title: tags.title } : {}),
        }
      }),
    durationMs: Number.isFinite(durationSeconds) && durationSeconds >= 0 ? Math.round(durationSeconds * 1_000) : 0,
    height: Number(video.height),
    subtitleStreams: streams
      .filter((stream) => stream.codec_type === "subtitle")
      .map((stream) => {
        const disposition = isRecord(stream.disposition) ? stream.disposition : {}
        const tags = isRecord(stream.tags) ? stream.tags : {}
        return {
          codec: typeof stream.codec_name === "string" ? stream.codec_name : "unknown",
          default: disposition.default === 1,
          forced: disposition.forced === 1,
          index: Number(stream.index),
          kind: "embedded" as const,
          ...(typeof tags.language === "string" ? { language: tags.language } : {}),
          ...(typeof tags.title === "string" ? { title: tags.title } : {}),
        }
      }),
    width: Number(video.width),
  })
}

export function parseWhisperJson(value: unknown, requestedLanguage: string) {
  if (!isRecord(value)) throw new Error("Whisper returned invalid JSON")
  const result = isRecord(value.result) ? value.result : {}
  const languageValue =
    typeof result.language === "string"
      ? result.language
      : typeof value.language === "string"
        ? value.language
        : requestedLanguage === "auto"
          ? "und"
          : requestedLanguage
  const language = canonicalSubtitleLanguage(languageValue, "Detected subtitle language")
  const transcription = Array.isArray(value.transcription)
    ? value.transcription
    : Array.isArray(value.segments)
      ? value.segments
      : null
  if (!transcription) throw new Error("Whisper did not return transcription segments")
  const cues = transcription.map((segment, index) => {
    if (!isRecord(segment) || typeof segment.text !== "string" || !segment.text.trim()) {
      throw new Error(`Whisper segment ${index} is invalid`)
    }
    const offsets = isRecord(segment.offsets) ? segment.offsets : {}
    const startMs = Number.isFinite(Number(offsets.from))
      ? Math.round(Number(offsets.from))
      : Math.round(Number(segment.start) * 1_000)
    const endMs = Number.isFinite(Number(offsets.to))
      ? Math.round(Number(offsets.to))
      : Math.round(Number(segment.end) * 1_000)
    return { endMs, id: `cue-${index + 1}`, startMs, text: segment.text.trim() }
  })
  return {
    language,
    track: parseSubtitleTrack({ cues, id: "source", kind: "source", language }),
  }
}

const p0TextSubtitleCodecs = new Set(["ass", "mov_text", "ssa", "subrip", "webvtt"])
const p0SdrPixelFormats = new Set([
  "bgr24",
  "nv12",
  "rgb24",
  "yuv420p",
  "yuv422p",
  "yuv444p",
  "yuvj420p",
  "yuvj422p",
  "yuvj444p",
])
const hdrColorPrimaries = new Set(["bt2020", "smpte431", "smpte432"])
const hdrColorSpaces = new Set(["bt2020c", "bt2020nc", "ictcp"])
const hdrTransfers = new Set(["arib-std-b67", "smpte2084"])

/** P0 is deliberately CFR, progressive, non-rotated, 8-bit SDR media. */
export function assertHardEraseP0MediaCompatibility(value: string, inspection: SubtitleMediaInspection): void {
  let parsed: unknown
  try {
    parsed = JSON.parse(value)
  } catch {
    throw new Error("Hard subtitle media probe returned invalid JSON")
  }
  if (!isRecord(parsed) || !Array.isArray(parsed.streams)) throw new Error("Hard subtitle probe returned no streams")
  const media = validateSubtitleMediaInspection(inspection)
  const streams = parsed.streams.filter(isRecord)
  const videos = streams.filter((stream) => {
    if (stream.codec_type !== "video") return false
    return (isRecord(stream.disposition) ? stream.disposition.attached_pic : undefined) !== 1
  })
  if (videos.length !== 1) throw new Error("Hard subtitle P0 requires exactly one primary video stream")
  const video = videos[0]!
  if (Number(video.width) !== media.width || Number(video.height) !== media.height) {
    throw new Error("Hard subtitle media changed after inspection")
  }
  const averageRate = parsePositiveFraction(video.avg_frame_rate)
  const nominalRate = parsePositiveFraction(video.r_frame_rate)
  if (averageRate === null || nominalRate === null || Math.abs(averageRate - nominalRate) > Math.max(0.001, nominalRate * 0.0001)) {
    throw new Error("Hard subtitle P0 supports constant-frame-rate video only")
  }
  const frameCount = Number(video.nb_frames)
  const videoDuration = Number(video.duration)
  if (!Number.isSafeInteger(frameCount) || frameCount < 1 || !Number.isFinite(videoDuration) || videoDuration <= 0 || Math.abs(frameCount - videoDuration * averageRate) > 1.5) {
    throw new Error("Hard subtitle P0 requires a verifiable constant-frame-rate timeline")
  }
  if (typeof video.pix_fmt !== "string" || !p0SdrPixelFormats.has(video.pix_fmt)) {
    throw new Error("Hard subtitle P0 supports 8-bit SDR video only")
  }
  if (
    (typeof video.color_transfer === "string" && hdrTransfers.has(video.color_transfer)) ||
    (typeof video.color_primaries === "string" && hdrColorPrimaries.has(video.color_primaries)) ||
    (typeof video.color_space === "string" && hdrColorSpaces.has(video.color_space))
  ) {
    throw new Error("Hard subtitle P0 does not support HDR or wide-color video")
  }
  if (typeof video.field_order === "string" && !["progressive", "unknown"].includes(video.field_order)) {
    throw new Error("Hard subtitle P0 does not support interlaced video")
  }
  const tags = isRecord(video.tags) ? video.tags : {}
  const rotations = [Number(tags.rotate)]
  if (Array.isArray(video.side_data_list)) {
    rotations.push(...video.side_data_list.filter(isRecord).map((item) => Number(item.rotation)))
  }
  if (rotations.some((rotation) => Number.isFinite(rotation) && Math.abs(rotation % 360) > 0.01)) {
    throw new Error("Hard subtitle P0 requires video without rotation metadata")
  }
  if (
    streams.some(
      (stream) =>
        stream.codec_type === "subtitle" &&
        (typeof stream.codec_name !== "string" || !p0TextSubtitleCodecs.has(stream.codec_name)),
    )
  ) {
    throw new Error("Hard subtitle P0 cannot preserve bitmap or unsupported subtitle streams")
  }
}

export function assertH264Mp4HardEraseOutput(value: string): void {
  let parsed: unknown
  try {
    parsed = JSON.parse(value)
  } catch {
    throw new Error("Hard subtitle output probe returned invalid JSON")
  }
  if (!isRecord(parsed) || !Array.isArray(parsed.streams)) throw new Error("Hard subtitle output has no streams")
  const video = parsed.streams.filter(isRecord).find((stream) => stream.codec_type === "video")
  if (!video || video.codec_name !== "h264" || video.codec_tag_string !== "avc1" || video.pix_fmt !== "yuv420p") {
    throw new Error("Hard subtitle output is not H.264 avc1/yuv420p video")
  }
}

function parsePositiveFraction(value: unknown): number | null {
  if (typeof value !== "string" || !/^\d+(?:\.\d+)?\/\d+(?:\.\d+)?$/u.test(value)) return null
  const [numeratorValue, denominatorValue] = value.split("/")
  const numerator = Number(numeratorValue)
  const denominator = Number(denominatorValue)
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || numerator <= 0 || denominator <= 0) return null
  return numerator / denominator
}
