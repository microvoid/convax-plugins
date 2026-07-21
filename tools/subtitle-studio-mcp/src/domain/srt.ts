import {
  canonicalSubtitleLanguage,
  parseSubtitleTrack,
  type SubtitleCue,
  type SubtitleTrack,
  type SubtitleTrackKind,
} from "./document"

const srtTimestamp = /^(\d{1,9}):(\d{2}):(\d{2})[,.](\d{3})\s*-->\s*(\d{1,9}):(\d{2}):(\d{2})[,.](\d{3})(?:\s+.*)?$/u

export interface ParseSrtOptions {
  id: string
  kind?: SubtitleTrackKind
  label?: string
  language: string
  sourceTrackId?: string
}

export interface ExportSrtOptions {
  includeUtf8Bom?: boolean
  lineEnding?: "crlf" | "lf"
}

function parseTimestamp(parts: RegExpMatchArray, offset: number) {
  const hours = Number(parts[offset])
  const minutes = Number(parts[offset + 1])
  const seconds = Number(parts[offset + 2])
  const milliseconds = Number(parts[offset + 3])
  if (!Number.isSafeInteger(hours) || minutes > 59 || seconds > 59 || !Number.isSafeInteger(milliseconds)) {
    throw new Error("SRT timestamp is invalid")
  }
  const result = ((hours * 60 + minutes) * 60 + seconds) * 1_000 + milliseconds
  if (!Number.isSafeInteger(result)) throw new Error("SRT timestamp exceeds the supported duration")
  return result
}

function parseCueBlock(block: string, sequence: number): SubtitleCue {
  const lines = block.split("\n")
  if (lines.length < 2) throw new Error(`SRT cue ${sequence} is incomplete`)
  const firstIsTimestamp = srtTimestamp.test(lines[0]!.trim())
  const timestampIndex = firstIsTimestamp ? 0 : 1
  if (!firstIsTimestamp && !/^\d+$/u.test(lines[0]!.trim())) {
    throw new Error(`SRT cue ${sequence} does not have a numeric index`)
  }
  const match = lines[timestampIndex]?.trim().match(srtTimestamp)
  if (!match) throw new Error(`SRT cue ${sequence} has an invalid timestamp`)
  const startMs = parseTimestamp(match, 1)
  const endMs = parseTimestamp(match, 5)
  if (endMs <= startMs) throw new Error(`SRT cue ${sequence} must end after it starts`)
  const text = lines
    .slice(timestampIndex + 1)
    .join("\n")
    .trim()
  if (!text) throw new Error(`SRT cue ${sequence} has no text`)
  return { endMs, id: `cue_${sequence}`, startMs, text }
}

export function parseSrt(value: string, options: ParseSrtOptions): SubtitleTrack {
  if (typeof value !== "string" || !value.trim()) throw new Error("SRT document must contain cues")
  const normalized = value
    .replace(/^\uFEFF/u, "")
    .replaceAll("\r\n", "\n")
    .replaceAll("\r", "\n")
    .trim()
  const blocks = normalized.split(/\n[\t ]*\n+/u).filter((block) => block.trim())
  const track = {
    cues: blocks.map((block, index) => parseCueBlock(block, index + 1)),
    id: options.id,
    kind: options.kind ?? "source",
    ...(options.label === undefined ? {} : { label: options.label }),
    language: canonicalSubtitleLanguage(options.language),
    ...(options.sourceTrackId === undefined ? {} : { sourceTrackId: options.sourceTrackId }),
  }
  return parseSubtitleTrack(track)
}

export function formatSrtTimestamp(milliseconds: number) {
  if (!Number.isSafeInteger(milliseconds) || milliseconds < 0) {
    throw new Error("SRT timestamp must be a non-negative integer")
  }
  const hours = Math.floor(milliseconds / 3_600_000)
  const minutes = Math.floor(milliseconds / 60_000) % 60
  const seconds = Math.floor(milliseconds / 1_000) % 60
  const remainder = milliseconds % 1_000
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")},${String(remainder).padStart(3, "0")}`
}

export function exportSrt(track: SubtitleTrack, options: ExportSrtOptions = {}) {
  const parsed = parseSubtitleTrack(track)
  const value = `${parsed.cues
    .map((cue, index) =>
      [String(index + 1), `${formatSrtTimestamp(cue.startMs)} --> ${formatSrtTimestamp(cue.endMs)}`, cue.text].join(
        "\n",
      ),
    )
    .join("\n\n")}\n`
  const withLineEnding = options.lineEnding === "crlf" ? value.replaceAll("\n", "\r\n") : value
  return options.includeUtf8Bom ? `\uFEFF${withLineEnding}` : withLineEnding
}
