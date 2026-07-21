import {
  canonicalSubtitleLanguage,
  parseSubtitleDocument,
  validateNormalizedSubtitleRegion,
  type NormalizedSubtitleRegion,
  type SubtitleDocument,
} from "./domain"

export const generationCallSchema = "convax.generation-call/1" as const
export const generationResultSchema = "convax.generation-result/1" as const

export type GenerationOutput = "image" | "text" | "video"
export type SubtitleToolName =
  | "subtitle.inspect"
  | "subtitle.transcribe"
  | "subtitle.erase-soft"
  | "subtitle.preview-hard"
  | "subtitle.erase-hard"
  | "subtitle.mux-soft"
export type SubtitleModelSize = "base" | "small" | "tiny"

export interface FileGenerationReference {
  kind: "file"
  mime_type: string
  name: string
  node_id: string
  path: string
  role: "reference_video"
}

interface BaseGenerationCall {
  operation_id: string
  output_directory: string
  prompt: string
  references: [FileGenerationReference]
  schema: typeof generationCallSchema
}

export type SubtitleGenerationCall =
  | (BaseGenerationCall & {
      input: Record<string, never>
      output: "text"
      tool: "subtitle.inspect"
    })
  | (BaseGenerationCall & {
      input: { language: "auto" | string; model: SubtitleModelSize }
      output: "text"
      tool: "subtitle.transcribe"
    })
  | (BaseGenerationCall & {
      input: { streamIndexes: number[] }
      output: "video"
      tool: "subtitle.erase-soft"
    })
  | (BaseGenerationCall & {
      input: { region: NormalizedSubtitleRegion; timestampMs: number }
      output: "image"
      tool: "subtitle.preview-hard"
    })
  | (BaseGenerationCall & {
      input: { region: NormalizedSubtitleRegion }
      output: "video"
      tool: "subtitle.erase-hard"
    })
  | (BaseGenerationCall & {
      input: { document: SubtitleDocument }
      output: "video"
      tool: "subtitle.mux-soft"
    })

export interface GenerationArtifact {
  mimeType: string
  name: string
  path: string
}

export interface JsonRpcRequest {
  id?: number | string | null
  jsonrpc: "2.0"
  method: string
  params?: unknown
}

export interface ToolResult {
  content: Array<{ type: "text"; text: string }>
  isError?: boolean
  structuredContent?: {
    artifacts: GenerationArtifact[]
    schema: typeof generationResultSchema
  }
}

export interface SubtitleToolDefinition {
  description: string
  inputSchema: Record<string, unknown>
  name: SubtitleToolName
  output: GenerationOutput
}

const maximumSubtitleDocumentJsonLength = 245_760
const envelopeKeys = ["operation_id", "output", "output_directory", "prompt", "references", "schema"] as const

const generationEnvelopeProperties = {
  operation_id: { maxLength: 256, minLength: 1, type: "string" },
  output_directory: { maxLength: 4_096, minLength: 1, type: "string" },
  prompt: { maxLength: 20_000, minLength: 1, type: "string" },
  references: { items: { type: "object" }, maxItems: 1, minItems: 1, type: "array" },
  schema: { const: generationCallSchema, type: "string" },
} as const

const regionProperties = {
  height: {
    default: 0.22,
    description: "Normalized subtitle search-region height.",
    maximum: 1,
    minimum: Number.EPSILON,
    title: "Region height",
    type: "number",
  },
  width: {
    default: 0.9,
    description: "Normalized subtitle search-region width.",
    maximum: 1,
    minimum: Number.EPSILON,
    title: "Region width",
    type: "number",
  },
  x: {
    default: 0.05,
    description: "Normalized left edge of the subtitle search region.",
    maximum: 1,
    minimum: 0,
    title: "Region X",
    type: "number",
  },
  y: {
    default: 0.73,
    description: "Normalized top edge of the subtitle search region.",
    maximum: 1,
    minimum: 0,
    title: "Region Y",
    type: "number",
  },
} as const

function defineTool(input: {
  customProperties?: Record<string, unknown>
  customRequired?: readonly string[]
  description: string
  name: SubtitleToolName
  output: GenerationOutput
}): SubtitleToolDefinition {
  return {
    description: input.description,
    inputSchema: {
      additionalProperties: false,
      properties: {
        ...generationEnvelopeProperties,
        output: { const: input.output, type: "string" },
        ...input.customProperties,
      },
      required: [...envelopeKeys, ...(input.customRequired ?? [])],
      type: "object",
    },
    name: input.name,
    output: input.output,
  }
}

export const subtitleTools: readonly SubtitleToolDefinition[] = [
  defineTool({
    description: "Inspect audio and embedded text-subtitle streams in one staged video.",
    name: "subtitle.inspect",
    output: "text",
  }),
  defineTool({
    customProperties: {
      language: {
        default: "auto",
        description: "BCP-47 speech language or auto detection.",
        maxLength: 64,
        minLength: 2,
        title: "Speech language",
        type: "string",
      },
      model: {
        default: "tiny",
        description: "Installed local Whisper model size.",
        enum: ["tiny", "base", "small"],
        title: "Whisper model",
        type: "string",
      },
    },
    customRequired: ["language", "model"],
    description: "Transcribe the selected video audio stream into a timestamped subtitle document.",
    name: "subtitle.transcribe",
    output: "text",
  }),
  defineTool({
    customProperties: {
      stream_indexes_json: {
        description: "JSON array of embedded subtitle stream indexes to remove.",
        maxLength: 2_048,
        minLength: 3,
        title: "Subtitle stream indexes",
        type: "string",
      },
    },
    customRequired: ["stream_indexes_json"],
    description: "Remux one video while excluding selected embedded text-subtitle streams.",
    name: "subtitle.erase-soft",
    output: "video",
  }),
  defineTool({
    customProperties: {
      ...regionProperties,
      timestamp_ms: {
        default: 0,
        description: "Video timestamp used for the preview frame.",
        maximum: 604_800_000,
        minimum: 0,
        title: "Preview time (ms)",
        type: "integer",
      },
    },
    customRequired: ["timestamp_ms", "x", "y", "width", "height"],
    description: "Create one preview frame using the selected normalized subtitle search region.",
    name: "subtitle.preview-hard",
    output: "image",
  }),
  defineTool({
    customProperties: regionProperties,
    customRequired: ["x", "y", "width", "height"],
    description: "Detect and remove burned-in subtitles inside a bounded normalized region.",
    name: "subtitle.erase-hard",
    output: "video",
  }),
  defineTool({
    customProperties: {
      subtitle_document_json: {
        description: "Validated convax.subtitle/1 document whose non-empty tracks will be embedded as soft subtitles.",
        maxLength: maximumSubtitleDocumentJsonLength,
        minLength: 2,
        title: "Subtitle document JSON",
        type: "string",
      },
    },
    customRequired: ["subtitle_document_json"],
    description: "Create one MP4 whose soft-subtitle streams match the supplied subtitle document.",
    name: "subtitle.mux-soft",
    output: "video",
  }),
] as const

const toolsByName: ReadonlyMap<SubtitleToolName, SubtitleToolDefinition> = new Map(
  subtitleTools.map((tool) => [tool.name, tool]),
)

export class SubtitleInputError extends Error {
  constructor(readonly publicMessage: string) {
    super(publicMessage)
    this.name = "SubtitleInputError"
  }
}

export function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new SubtitleInputError(`${label} must be an object.`)
  }
  return value as Record<string, unknown>
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[], label: string) {
  const expected = new Set(keys)
  if (Object.keys(value).length !== expected.size || Object.keys(value).some((key) => !expected.has(key))) {
    throw new SubtitleInputError(`${label} contains unsupported fields.`)
  }
}

function requiredString(value: unknown, label: string, maximum: number) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maximum ||
    value !== value.trim() ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw new SubtitleInputError(`${label} must be a non-empty trimmed string.`)
  }
  return value
}

function parseReference(value: unknown): FileGenerationReference {
  const reference = asRecord(value, "generation reference")
  exactKeys(reference, ["kind", "mime_type", "name", "node_id", "path", "role"], "generation reference")
  if (reference.kind !== "file" || reference.role !== "reference_video") {
    throw new SubtitleInputError("Subtitle tools require one staged reference_video file.")
  }
  const mimeType = requiredString(reference.mime_type, "generation reference mime_type", 256).toLowerCase()
  if (!mimeType.startsWith("video/")) {
    throw new SubtitleInputError("Subtitle reference MIME type must be video media.")
  }
  return {
    kind: "file",
    mime_type: mimeType,
    name: requiredString(reference.name, "generation reference name", 512),
    node_id: requiredString(reference.node_id, "generation reference node_id", 256),
    path: requiredString(reference.path, "generation reference path", 4_096),
    role: "reference_video",
  }
}

function parseRegion(input: Record<string, unknown>) {
  try {
    return validateNormalizedSubtitleRegion({
      height: input.height as number,
      width: input.width as number,
      x: input.x as number,
      y: input.y as number,
    })
  } catch {
    throw new SubtitleInputError("Hard-subtitle region must be normalized and remain inside the video frame.")
  }
}

function parseStreamIndexes(value: unknown) {
  const serialized = requiredString(value, "stream_indexes_json", 2_048)
  let parsed: unknown
  try {
    parsed = JSON.parse(serialized) as unknown
  } catch {
    throw new SubtitleInputError("stream_indexes_json must be valid JSON.")
  }
  if (
    !Array.isArray(parsed) ||
    parsed.length < 1 ||
    parsed.length > 256 ||
    parsed.some((index) => !Number.isSafeInteger(index) || index < 0 || index > 65_535) ||
    new Set(parsed).size !== parsed.length
  ) {
    throw new SubtitleInputError("stream_indexes_json must contain unique non-negative stream indexes.")
  }
  return [...parsed].sort((left, right) => (left as number) - (right as number)) as number[]
}

function parseSubtitleDocumentJson(value: unknown) {
  const serialized = requiredString(value, "subtitle_document_json", maximumSubtitleDocumentJsonLength)
  let parsed: unknown
  try {
    parsed = JSON.parse(serialized) as unknown
  } catch {
    throw new SubtitleInputError("subtitle_document_json must be valid JSON.")
  }
  let document: SubtitleDocument
  try {
    document = parseSubtitleDocument(parsed)
  } catch {
    throw new SubtitleInputError("subtitle_document_json must contain a valid convax.subtitle/1 document.")
  }
  if (!document.tracks.some((track) => track.cues.length > 0)) {
    throw new SubtitleInputError("subtitle_document_json must contain at least one non-empty subtitle track.")
  }
  return document
}

function parseTranscriptionLanguage(value: unknown) {
  const language = requiredString(value, "language", 64)
  if (language.toLowerCase() === "auto") return "auto" as const
  try {
    return canonicalSubtitleLanguage(language, "Transcription language")
  } catch {
    throw new SubtitleInputError("language must be auto or a valid BCP-47 language tag.")
  }
}

function parseModel(value: unknown): SubtitleModelSize {
  if (value !== "tiny" && value !== "base" && value !== "small") {
    throw new SubtitleInputError("model must be tiny, base, or small.")
  }
  return value
}

function parseTimestamp(value: unknown) {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > 604_800_000) {
    throw new SubtitleInputError("timestamp_ms must be an integer inside the supported video duration range.")
  }
  return value as number
}

export function subtitleToolForName(value: string): SubtitleToolDefinition | undefined {
  return toolsByName.get(value as SubtitleToolName)
}

export function parseSubtitleGenerationCall(
  value: unknown,
  tool: SubtitleToolDefinition,
): SubtitleGenerationCall {
  const input = asRecord(value, "generation call")
  const customKeys = (() => {
    if (tool.name === "subtitle.transcribe") return ["language", "model"]
    if (tool.name === "subtitle.erase-soft") return ["stream_indexes_json"]
    if (tool.name === "subtitle.preview-hard") return ["timestamp_ms", "x", "y", "width", "height"]
    if (tool.name === "subtitle.erase-hard") return ["x", "y", "width", "height"]
    if (tool.name === "subtitle.mux-soft") return ["subtitle_document_json"]
    return []
  })()
  exactKeys(input, [...envelopeKeys, ...customKeys], "generation call")
  if (input.schema !== generationCallSchema) {
    throw new SubtitleInputError("generation call schema is not supported.")
  }
  if (input.output !== tool.output) {
    throw new SubtitleInputError("generation call output does not match the selected tool.")
  }
  if (!Array.isArray(input.references) || input.references.length !== 1) {
    throw new SubtitleInputError("Subtitle tools require exactly one reference_video file.")
  }
  const base = {
    operation_id: requiredString(input.operation_id, "operation_id", 256),
    output_directory: requiredString(input.output_directory, "output_directory", 4_096),
    prompt: requiredString(input.prompt, "prompt", 20_000),
    references: [parseReference(input.references[0])] as [FileGenerationReference],
    schema: generationCallSchema,
  }
  if (tool.name === "subtitle.inspect") {
    return { ...base, input: {}, output: "text", tool: tool.name }
  }
  if (tool.name === "subtitle.transcribe") {
    return {
      ...base,
      input: { language: parseTranscriptionLanguage(input.language), model: parseModel(input.model) },
      output: "text",
      tool: tool.name,
    }
  }
  if (tool.name === "subtitle.erase-soft") {
    return {
      ...base,
      input: { streamIndexes: parseStreamIndexes(input.stream_indexes_json) },
      output: "video",
      tool: tool.name,
    }
  }
  if (tool.name === "subtitle.preview-hard") {
    return {
      ...base,
      input: { region: parseRegion(input), timestampMs: parseTimestamp(input.timestamp_ms) },
      output: "image",
      tool: tool.name,
    }
  }
  if (tool.name === "subtitle.erase-hard") {
    return { ...base, input: { region: parseRegion(input) }, output: "video", tool: tool.name }
  }
  return {
    ...base,
    input: { document: parseSubtitleDocumentJson(input.subtitle_document_json) },
    output: "video",
    tool: "subtitle.mux-soft",
  }
}
