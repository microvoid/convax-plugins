import path from "node:path"

export const generationCallSchema = "convax.generation-call/1" as const
export const pluginServiceStatusSchema = "convax.plugin-service-status/1" as const
export const llmGatewaySchema = "convax.llm-gateway/1" as const

export const codexLlmModels = [
  { id: "gpt-5.6-sol", name: "GPT-5.6-Sol" },
  { id: "gpt-5.6-terra", name: "GPT-5.6-Terra" },
  { id: "gpt-5.6-luna", name: "GPT-5.6-Luna" },
  { id: "gpt-5.5", name: "GPT-5.5" },
] as const

export type CodexLlmModelId = typeof codexLlmModels[number]["id"]
export const codexLlmModelIds: ReadonlySet<string> = new Set(codexLlmModels.map((model) => model.id))
export const codexImageToolId = "image.gpt-image-2" as const

export interface JsonRpcRequest {
  id?: number | string | null
  jsonrpc: "2.0"
  method: string
  params?: unknown
}

export interface GenerationReference {
  kind: "file"
  mime_type: string
  name: string
  node_id: string
  path: string
  role: "reference_image"
}

export interface GenerationCall {
  operation_id: string
  output: "image"
  output_directory: string
  prompt: string
  references: GenerationReference[]
  schema: typeof generationCallSchema
}

export interface GenerationArtifact {
  mimeType: string
  name: string
  path: string
}

export interface PluginServiceStatus {
  account:
    | { availability: "available"; displayName: string }
    | { availability: "unavailable" }
  credential: {
    configured: boolean
    verification: "verified" | "unverified" | "failed" | "unknown"
  }
  credits:
    | { availability: "available"; remaining: number; unit: string }
    | { availability: "unavailable" }
  schema: typeof pluginServiceStatusSchema
  state: "connected" | "disconnected" | "attention" | "unknown"
  usage:
    | { availability: "available"; consumed: number; period?: string; unit: string }
    | { availability: "unavailable" }
}

export interface LlmGatewayDescriptor {
  api_key: string
  base_url: string
  schema: typeof llmGatewaySchema
}

export interface ToolResult {
  content: Array<{ text: string; type: "text" }>
  isError?: boolean
  structuredContent?:
    | { artifacts: GenerationArtifact[] }
    | LlmGatewayDescriptor
    | PluginServiceStatus
}

export function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`)
  }
  return value as Record<string, unknown>
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[], label: string) {
  const expected = new Set(keys)
  if (Object.keys(value).length !== keys.length || Object.keys(value).some((key) => !expected.has(key))) {
    throw new Error(`${label} contains unsupported fields`)
  }
}

function trimmedString(value: unknown, label: string, maximumLength: number) {
  if (
    typeof value !== "string"
    || value.length === 0
    || value.length > maximumLength
    || value !== value.trim()
    || /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw new Error(`${label} is invalid`)
  }
  return value
}

export function parseGenerationCall(value: unknown): GenerationCall {
  const input = asRecord(value, "generation call")
  exactKeys(
    input,
    ["schema", "operation_id", "prompt", "output", "output_directory", "references"],
    "generation call",
  )
  if (input.schema !== generationCallSchema || input.output !== "image") {
    throw new Error("generation call contract is not supported")
  }
  const outputDirectory = trimmedString(input.output_directory, "generation output directory", 4_096)
  if (!path.isAbsolute(outputDirectory)) throw new Error("generation output directory must be absolute")
  if (!Array.isArray(input.references) || input.references.length > 16) {
    throw new Error("generation references are invalid")
  }
  const nodeIds = new Set<string>()
  const references = input.references.map((value, index) => {
    const reference = asRecord(value, `generation reference ${index}`)
    exactKeys(reference, ["kind", "mime_type", "name", "node_id", "path", "role"], `generation reference ${index}`)
    if (reference.kind !== "file" || reference.role !== "reference_image") {
      throw new Error("generation reference must be a staged reference image")
    }
    const mimeType = trimmedString(reference.mime_type, "generation reference MIME type", 255)
    const referencePath = trimmedString(reference.path, "generation reference path", 4_096)
    const nodeId = trimmedString(reference.node_id, "generation reference node id", 256)
    if (!mimeType.startsWith("image/") || !path.isAbsolute(referencePath) || nodeIds.has(nodeId)) {
      throw new Error("generation reference is invalid")
    }
    nodeIds.add(nodeId)
    return {
      kind: "file" as const,
      mime_type: mimeType,
      name: trimmedString(reference.name, "generation reference name", 255),
      node_id: nodeId,
      path: referencePath,
      role: "reference_image" as const,
    }
  })
  return {
    operation_id: trimmedString(input.operation_id, "generation operation id", 256),
    output: "image",
    output_directory: outputDirectory,
    prompt: trimmedString(input.prompt, "generation prompt", 20_000),
    references,
    schema: generationCallSchema,
  }
}
