export const generationCallSchema = "convax.generation-call/1" as const
export const generationResultSchema = "convax.generation-result/1" as const

export type GenerationOutput = "image" | "video" | "audio"
export type GenerationReferenceRole =
  | "reference_image"
  | "reference_video"
  | "first_frame"
  | "last_frame"
  | "audio"

export interface FileGenerationReference {
  kind: "file"
  mime_type: string
  name: string
  node_id: string
  path: string
  role: GenerationReferenceRole
}

export interface GenerationCall {
  arguments_json: string
  operation_id: string
  output: GenerationOutput
  output_directory: string
  output_name: string
  prompt: string
  references: FileGenerationReference[]
  schema: typeof generationCallSchema
}

export interface HighLevelParameter {
  integer?: true
  maximum: number
  minimum: number
  name: string
}

export interface HighLevelToolSpecification {
  arguments(values: Readonly<Record<string, number>>): string[]
  description: string
  name: string
  output: GenerationOutput
  outputName: string
  parameters: readonly HighLevelParameter[]
}

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

const referenceRoles = new Set<GenerationReferenceRole>([
  "reference_image",
  "reference_video",
  "first_frame",
  "last_frame",
  "audio",
])

const outputExtensions: Readonly<Record<GenerationOutput, Readonly<Record<string, string>>>> = {
  image: {
    gif: "image/gif",
    jpeg: "image/jpeg",
    jpg: "image/jpeg",
    png: "image/png",
    webp: "image/webp",
  },
  video: {
    mov: "video/quicktime",
    mp4: "video/mp4",
    webm: "video/webm",
  },
  audio: {
    flac: "audio/flac",
    m4a: "audio/mp4",
    mp3: "audio/mpeg",
    ogg: "audio/ogg",
    wav: "audio/wav",
  },
}

const videoEncodingArguments = [
  "-map", "0:v:0",
  "-map", "0:a?",
  "-c:v", "h264_videotoolbox",
  "-allow_sw", "1",
  "-b:v", "8M",
  "-profile:v", "high",
  "-pix_fmt", "yuv420p",
  "-c:a", "aac",
  "-b:a", "192k",
  "-movflags", "+faststart",
] as const

const videoOnlyEncodingArguments = [
  "-map", "0:v:0",
  "-an",
  "-c:v", "h264_videotoolbox",
  "-allow_sw", "1",
  "-b:v", "8M",
  "-profile:v", "high",
  "-pix_fmt", "yuv420p",
  "-movflags", "+faststart",
] as const

export const highLevelToolSpecifications: readonly HighLevelToolSpecification[] = [
  {
    name: "frame.extract",
    output: "image",
    outputName: "frame.png",
    description: "Extract one PNG frame at a selected time from one staged video.",
    parameters: [{ name: "time_seconds", minimum: 0, maximum: 604_800 }],
    arguments: ({ time_seconds }) => [
      "-ss", String(time_seconds), "-i", "{{input:0}}", "-map", "0:v:0", "-frames:v", "1", "-an", "{{output}}",
    ],
  },
  {
    name: "video.trim",
    output: "video",
    outputName: "trimmed.mp4",
    description: "Create one MP4 from a selected time range in one staged video.",
    parameters: [
      { name: "start_seconds", minimum: 0, maximum: 604_800 },
      { name: "duration_seconds", minimum: Number.EPSILON, maximum: 604_800 },
    ],
    arguments: ({ start_seconds, duration_seconds }) => [
      "-ss", String(start_seconds), "-i", "{{input:0}}", "-t", String(duration_seconds),
      ...videoEncodingArguments, "{{output}}",
    ],
  },
  {
    name: "video.crop",
    output: "video",
    outputName: "cropped.mp4",
    description: "Create one MP4 from a selected rectangular region in one staged video.",
    parameters: [
      { name: "x", integer: true, minimum: 0, maximum: 32_768 },
      { name: "y", integer: true, minimum: 0, maximum: 32_768 },
      { name: "width", integer: true, minimum: 1, maximum: 32_768 },
      { name: "height", integer: true, minimum: 1, maximum: 32_768 },
    ],
    arguments: ({ x, y, width, height }) => [
      "-i", "{{input:0}}", "-vf", `crop=${width}:${height}:${x}:${y}`,
      ...videoEncodingArguments, "{{output}}",
    ],
  },
  {
    name: "video.without-audio",
    output: "video",
    outputName: "video-only.mp4",
    description: "Create one video-only MP4 from one staged video.",
    parameters: [],
    arguments: () => ["-i", "{{input:0}}", ...videoOnlyEncodingArguments, "{{output}}"],
  },
  {
    name: "audio.extract",
    output: "audio",
    outputName: "audio-only.m4a",
    description: "Create one audio-only M4A from one staged video.",
    parameters: [],
    arguments: () => [
      "-i", "{{input:0}}", "-map", "0:a:0", "-vn", "-c:a", "aac", "-b:a", "192k", "{{output}}",
    ],
  },
] as const

export class FfmpegInputError extends Error {
  constructor(readonly publicMessage: string) {
    super(publicMessage)
    this.name = "FfmpegInputError"
  }
}

export function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new FfmpegInputError(`${label} must be an object.`)
  }
  return value as Record<string, unknown>
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[], label: string) {
  const expected = new Set(keys)
  if (Object.keys(value).length !== expected.size || Object.keys(value).some((key) => !expected.has(key))) {
    throw new FfmpegInputError(`${label} contains unsupported fields.`)
  }
}

function requiredString(value: unknown, label: string, maxLength: number) {
  if (
    typeof value !== "string"
    || value.length === 0
    || value.length > maxLength
    || value !== value.trim()
    || /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw new FfmpegInputError(`${label} must be a non-empty trimmed string.`)
  }
  return value
}

function parseOutputName(value: unknown, output: GenerationOutput) {
  const name = requiredString(value, "output_name", 128)
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(name) || name === "." || name === "..") {
    throw new FfmpegInputError("output_name must be a portable file basename.")
  }
  const separator = name.lastIndexOf(".")
  const extension = separator < 0 ? "" : name.slice(separator + 1).toLowerCase()
  const mimeType = outputExtensions[output][extension]
  if (!mimeType) {
    throw new FfmpegInputError(`output_name extension is not supported for ${output} output.`)
  }
  return { mimeType, name }
}

export function parseGenerationCall(value: unknown, expectedOutput: GenerationOutput): GenerationCall {
  const input = asRecord(value, "generation call")
  exactKeys(input, [
    "arguments_json",
    "operation_id",
    "output",
    "output_directory",
    "output_name",
    "prompt",
    "references",
    "schema",
  ], "generation call")
  if (input.schema !== generationCallSchema) {
    throw new FfmpegInputError("generation call schema is not supported.")
  }
  if (input.output !== expectedOutput) {
    throw new FfmpegInputError("generation call output does not match the selected tool.")
  }
  if (!Array.isArray(input.references) || input.references.length > 16) {
    throw new FfmpegInputError("generation references must contain at most 16 files.")
  }
  const references = input.references.map((value, index): FileGenerationReference => {
    const reference = asRecord(value, `generation reference ${index}`)
    exactKeys(reference, ["kind", "mime_type", "name", "node_id", "path", "role"], `generation reference ${index}`)
    if (reference.kind !== "file") {
      throw new FfmpegInputError(`generation reference ${index} must be a staged file.`)
    }
    if (typeof reference.role !== "string" || !referenceRoles.has(reference.role as GenerationReferenceRole)) {
      throw new FfmpegInputError(`generation reference ${index} has an unsupported role.`)
    }
    return {
      kind: "file",
      mime_type: requiredString(reference.mime_type, `generation reference ${index} mime_type`, 256),
      name: requiredString(reference.name, `generation reference ${index} name`, 512),
      node_id: requiredString(reference.node_id, `generation reference ${index} node_id`, 256),
      path: requiredString(reference.path, `generation reference ${index} path`, 4_096),
      role: reference.role as GenerationReferenceRole,
    }
  })
  const output = expectedOutput
  const outputName = parseOutputName(input.output_name, output)
  return {
    arguments_json: requiredString(input.arguments_json, "arguments_json", 4_096),
    operation_id: requiredString(input.operation_id, "operation_id", 256),
    output,
    output_directory: requiredString(input.output_directory, "output_directory", 4_096),
    output_name: outputName.name,
    prompt: requiredString(input.prompt, "prompt", 20_000),
    references,
    schema: generationCallSchema,
  }
}

export function parseHighLevelGenerationCall(
  value: unknown,
  specification: HighLevelToolSpecification,
): GenerationCall {
  const input = asRecord(value, "generation call")
  const envelopeKeys = [
    "operation_id",
    "output",
    "output_directory",
    "prompt",
    "references",
    "schema",
  ] as const
  exactKeys(input, [...envelopeKeys, ...specification.parameters.map((parameter) => parameter.name)], "generation call")
  const parameters: Record<string, number> = {}
  for (const parameter of specification.parameters) {
    const number = input[parameter.name]
    if (
      typeof number !== "number"
      || !Number.isFinite(number)
      || parameter.integer === true && !Number.isSafeInteger(number)
      || number < parameter.minimum
      || number > parameter.maximum
    ) {
      throw new FfmpegInputError(`${parameter.name} is outside the supported range.`)
    }
    parameters[parameter.name] = number
  }
  const call = parseGenerationCall({
    arguments_json: JSON.stringify(specification.arguments(parameters)),
    operation_id: input.operation_id,
    output: input.output,
    output_directory: input.output_directory,
    output_name: specification.outputName,
    prompt: input.prompt,
    references: input.references,
    schema: input.schema,
  }, specification.output)
  if (call.references.length !== 1 || call.references[0]?.role !== "reference_video") {
    throw new FfmpegInputError(`${specification.name} requires exactly one reference_video file.`)
  }
  return call
}

export function mimeTypeForOutput(name: string, output: GenerationOutput) {
  return parseOutputName(name, output).mimeType
}
