export const subtitleDocumentSchema = "convax.subtitle/1" as const

export type SubtitleTrackKind = "source" | "translation"

export interface SubtitleWord {
  confidence?: number
  endMs: number
  startMs: number
  text: string
}

export interface SubtitleCue {
  confidence?: number
  endMs: number
  id: string
  speakerId?: string
  startMs: number
  text: string
  words?: SubtitleWord[]
}

export interface SubtitleTrack {
  cues: SubtitleCue[]
  id: string
  kind: SubtitleTrackKind
  label?: string
  language: string
  sourceTrackId?: string
}

export interface SubtitleMediaSource {
  durationMs: number
  fingerprint?: string
  mediaName: string
}

export interface SubtitleProvenance {
  createdAt: string
  engine?: string
  mode: "imported" | "transcribed" | "translated" | "edited"
  model?: string
}

export interface SubtitleDocument {
  id: string
  provenance: SubtitleProvenance[]
  revision: number
  schema: typeof subtitleDocumentSchema
  source: SubtitleMediaSource
  tracks: SubtitleTrack[]
}

export interface CreateSubtitleDocumentInput {
  id: string
  provenance?: SubtitleProvenance[]
  source: SubtitleMediaSource
  tracks?: SubtitleTrack[]
}

const maximumTracks = 64
const maximumCuesPerTrack = 100_000
const maximumCueTextLength = 16_384
const maximumIdentifierLength = 256
const maximumMediaNameLength = 1_024

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
}

function requireExactKeys(value: Record<string, unknown>, keys: readonly string[], label: string) {
  const allowed = new Set(keys)
  const unsupported = Object.keys(value).find((key) => !allowed.has(key))
  if (unsupported) throw new Error(`${label} contains an unsupported field: ${unsupported}`)
}

function requireString(value: unknown, label: string, maximum = maximumIdentifierLength) {
  if (
    typeof value !== "string" ||
    value !== value.trim() ||
    !value ||
    value.length > maximum ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw new Error(`${label} must be a non-empty, trimmed string`)
  }
  return value
}

function requireText(value: unknown, label: string) {
  if (typeof value !== "string" || !value.trim() || value.length > maximumCueTextLength || /\u0000/u.test(value)) {
    throw new Error(`${label} must contain subtitle text`)
  }
  const normalized = value.replaceAll("\r\n", "\n").replaceAll("\r", "\n").trim()
  if (/\n[\t ]*\n/u.test(normalized)) throw new Error(`${label} cannot contain blank subtitle lines`)
  return normalized
}

function requireSafeMilliseconds(value: unknown, label: string) {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error(`${label} must be a non-negative integer`)
  }
  return value as number
}

function requireConfidence(value: unknown, label: string) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(`${label} must be between 0 and 1`)
  }
  return value
}

export function canonicalSubtitleLanguage(value: unknown, label = "Subtitle language") {
  const language = requireString(value, label, 64)
  try {
    const canonical = Intl.getCanonicalLocales(language)
    if (canonical.length !== 1) throw new Error("ambiguous language")
    return canonical[0]!
  } catch {
    throw new Error(`${label} must be a valid BCP-47 language tag`)
  }
}

function parseWord(value: unknown, cueStartMs: number, cueEndMs: number, index: number): SubtitleWord {
  if (!isRecord(value)) throw new Error(`Subtitle word ${index} must be an object`)
  requireExactKeys(value, ["confidence", "endMs", "startMs", "text"], `Subtitle word ${index}`)
  const startMs = requireSafeMilliseconds(value.startMs, `Subtitle word ${index} start`)
  const endMs = requireSafeMilliseconds(value.endMs, `Subtitle word ${index} end`)
  if (endMs <= startMs || startMs < cueStartMs || endMs > cueEndMs) {
    throw new Error(`Subtitle word ${index} must stay inside its cue`)
  }
  return {
    ...(value.confidence === undefined
      ? {}
      : { confidence: requireConfidence(value.confidence, `Subtitle word ${index} confidence`) }),
    endMs,
    startMs,
    text: requireText(value.text, `Subtitle word ${index} text`),
  }
}

function parseCue(value: unknown, index: number): SubtitleCue {
  if (!isRecord(value)) throw new Error(`Subtitle cue ${index} must be an object`)
  requireExactKeys(
    value,
    ["confidence", "endMs", "id", "speakerId", "startMs", "text", "words"],
    `Subtitle cue ${index}`,
  )
  const startMs = requireSafeMilliseconds(value.startMs, `Subtitle cue ${index} start`)
  const endMs = requireSafeMilliseconds(value.endMs, `Subtitle cue ${index} end`)
  if (endMs <= startMs) throw new Error(`Subtitle cue ${index} must end after it starts`)
  if (value.words !== undefined && !Array.isArray(value.words)) {
    throw new Error(`Subtitle cue ${index} words must be an array`)
  }
  const words = value.words?.map((word, wordIndex) => parseWord(word, startMs, endMs, wordIndex))
  if (words) {
    let previousStart = -1
    for (const word of words) {
      if (word.startMs < previousStart) throw new Error(`Subtitle cue ${index} words must be ordered`)
      previousStart = word.startMs
    }
  }
  return {
    ...(value.confidence === undefined
      ? {}
      : { confidence: requireConfidence(value.confidence, `Subtitle cue ${index} confidence`) }),
    endMs,
    id: requireString(value.id, `Subtitle cue ${index} id`),
    ...(value.speakerId === undefined
      ? {}
      : { speakerId: requireString(value.speakerId, `Subtitle cue ${index} speaker`) }),
    startMs,
    text: requireText(value.text, `Subtitle cue ${index} text`),
    ...(words === undefined ? {} : { words }),
  }
}

export function parseSubtitleTrack(value: unknown): SubtitleTrack {
  if (!isRecord(value)) throw new Error("Subtitle track must be an object")
  requireExactKeys(value, ["cues", "id", "kind", "label", "language", "sourceTrackId"], "Subtitle track")
  if (!Array.isArray(value.cues) || value.cues.length > maximumCuesPerTrack) {
    throw new Error(`Subtitle track cues must contain at most ${maximumCuesPerTrack} items`)
  }
  if (value.kind !== "source" && value.kind !== "translation") {
    throw new Error("Subtitle track kind must be source or translation")
  }
  const id = requireString(value.id, "Subtitle track id")
  const sourceTrackId =
    value.sourceTrackId === undefined ? undefined : requireString(value.sourceTrackId, "Subtitle source track id")
  if (value.kind === "translation" && !sourceTrackId) {
    throw new Error("Translated subtitle tracks require a source track id")
  }
  if (value.kind === "source" && sourceTrackId) {
    throw new Error("Source subtitle tracks cannot reference another source track")
  }
  const cues = value.cues.map(parseCue)
  const cueIds = new Set<string>()
  let previousStart = -1
  for (const cue of cues) {
    if (cueIds.has(cue.id)) throw new Error(`Subtitle cue id is duplicated: ${cue.id}`)
    if (cue.startMs < previousStart) throw new Error("Subtitle cues must be ordered by start time")
    cueIds.add(cue.id)
    previousStart = cue.startMs
  }
  return {
    cues,
    id,
    kind: value.kind,
    ...(value.label === undefined ? {} : { label: requireString(value.label, "Subtitle track label", 256) }),
    language: canonicalSubtitleLanguage(value.language),
    ...(sourceTrackId === undefined ? {} : { sourceTrackId }),
  }
}

function parseSource(value: unknown): SubtitleMediaSource {
  if (!isRecord(value)) throw new Error("Subtitle media source must be an object")
  requireExactKeys(value, ["durationMs", "fingerprint", "mediaName"], "Subtitle media source")
  return {
    durationMs: requireSafeMilliseconds(value.durationMs, "Subtitle media duration"),
    ...(value.fingerprint === undefined
      ? {}
      : { fingerprint: requireString(value.fingerprint, "Subtitle media fingerprint", 512) }),
    mediaName: requireString(value.mediaName, "Subtitle media name", maximumMediaNameLength),
  }
}

function parseProvenance(value: unknown, index: number): SubtitleProvenance {
  if (!isRecord(value)) throw new Error(`Subtitle provenance ${index} must be an object`)
  requireExactKeys(value, ["createdAt", "engine", "mode", "model"], `Subtitle provenance ${index}`)
  if (!(["edited", "imported", "transcribed", "translated"] as unknown[]).includes(value.mode)) {
    throw new Error(`Subtitle provenance ${index} mode is invalid`)
  }
  const createdAt = requireString(value.createdAt, `Subtitle provenance ${index} timestamp`, 64)
  if (!Number.isFinite(Date.parse(createdAt))) throw new Error(`Subtitle provenance ${index} timestamp is invalid`)
  return {
    createdAt,
    ...(value.engine === undefined
      ? {}
      : { engine: requireString(value.engine, `Subtitle provenance ${index} engine`, 256) }),
    mode: value.mode as SubtitleProvenance["mode"],
    ...(value.model === undefined
      ? {}
      : { model: requireString(value.model, `Subtitle provenance ${index} model`, 256) }),
  }
}

export function parseSubtitleDocument(value: unknown): SubtitleDocument {
  if (!isRecord(value)) throw new Error("Subtitle document must be an object")
  requireExactKeys(value, ["id", "provenance", "revision", "schema", "source", "tracks"], "Subtitle document")
  if (value.schema !== subtitleDocumentSchema) throw new Error("Subtitle document schema is not supported")
  if (!Number.isSafeInteger(value.revision) || (value.revision as number) < 0) {
    throw new Error("Subtitle document revision must be a non-negative integer")
  }
  if (!Array.isArray(value.tracks) || value.tracks.length > maximumTracks) {
    throw new Error(`Subtitle document tracks must contain at most ${maximumTracks} items`)
  }
  if (!Array.isArray(value.provenance) || value.provenance.length > 1_000) {
    throw new Error("Subtitle document provenance is invalid")
  }
  const tracks = value.tracks.map(parseSubtitleTrack)
  const trackIds = new Set<string>()
  for (const track of tracks) {
    if (trackIds.has(track.id)) throw new Error(`Subtitle track id is duplicated: ${track.id}`)
    trackIds.add(track.id)
  }
  for (const track of tracks) {
    if (track.sourceTrackId && !trackIds.has(track.sourceTrackId)) {
      throw new Error(`Subtitle source track does not exist: ${track.sourceTrackId}`)
    }
  }
  const trackById = new Map(tracks.map((track) => [track.id, track]))
  for (const track of tracks) {
    if (track.kind !== "translation") continue
    const sourceTrack = trackById.get(track.sourceTrackId!)
    if (!sourceTrack || sourceTrack.kind !== "source") {
      throw new Error(`Translated subtitle track must reference a source track: ${track.id}`)
    }
    if (track.cues.length !== sourceTrack.cues.length) {
      throw new Error(`Translated subtitle track changed the source cue count: ${track.id}`)
    }
    track.cues.forEach((cue, index) => {
      const sourceCue = sourceTrack.cues[index]!
      if (cue.id !== sourceCue.id || cue.startMs !== sourceCue.startMs || cue.endMs !== sourceCue.endMs) {
        throw new Error(`Translated subtitle track changed source cue identity or timing: ${track.id}`)
      }
    })
  }
  const source = parseSource(value.source)
  for (const track of tracks) {
    const outside = track.cues.find((cue) => cue.endMs > source.durationMs)
    if (outside) throw new Error(`Subtitle cue exceeds media duration: ${outside.id}`)
  }
  return {
    id: requireString(value.id, "Subtitle document id"),
    provenance: value.provenance.map(parseProvenance),
    revision: value.revision as number,
    schema: subtitleDocumentSchema,
    source,
    tracks,
  }
}

export function createSubtitleDocument(input: CreateSubtitleDocumentInput): SubtitleDocument {
  return parseSubtitleDocument({
    id: input.id,
    provenance: input.provenance ?? [],
    revision: 0,
    schema: subtitleDocumentSchema,
    source: input.source,
    tracks: input.tracks ?? [],
  })
}

export function replaceSubtitleTrack(
  document: SubtitleDocument,
  track: SubtitleTrack,
  provenance?: SubtitleProvenance,
): SubtitleDocument {
  const parsedDocument = parseSubtitleDocument(document)
  const parsedTrack = parseSubtitleTrack(track)
  let tracks = parsedDocument.tracks.some((candidate) => candidate.id === parsedTrack.id)
    ? parsedDocument.tracks.map((candidate) => (candidate.id === parsedTrack.id ? parsedTrack : candidate))
    : [...parsedDocument.tracks, parsedTrack]
  if (parsedTrack.kind === "source") {
    tracks = tracks.map((candidate) => {
      if (candidate.kind !== "translation" || candidate.sourceTrackId !== parsedTrack.id) return candidate
      if (
        candidate.cues.length !== parsedTrack.cues.length ||
        candidate.cues.some((cue, index) => cue.id !== parsedTrack.cues[index]?.id)
      ) {
        throw new Error(`Source cue structure changed while translated tracks exist: ${parsedTrack.id}`)
      }
      return {
        ...candidate,
        cues: candidate.cues.map((cue, index) => ({
          ...cue,
          endMs: parsedTrack.cues[index]!.endMs,
          startMs: parsedTrack.cues[index]!.startMs,
        })),
      }
    })
  }
  return parseSubtitleDocument({
    ...parsedDocument,
    provenance: provenance ? [...parsedDocument.provenance, provenance] : parsedDocument.provenance,
    revision: parsedDocument.revision + 1,
    tracks,
  })
}

export function serializeSubtitleDocument(document: SubtitleDocument) {
  return `${JSON.stringify(parseSubtitleDocument(document), null, 2)}\n`
}
