export const generationCallSchema = "convax.generation-call/1" as const
export const pluginServiceStatusSchema = "convax.plugin-service-status/1" as const
export const pluginServiceBrowserAuthorizationSchema =
  "convax.plugin-service-browser-authorization/1" as const
export const pluginServiceBrowserAuthorizationCompletionSchema =
  "convax.plugin-service-browser-authorization-completion/1" as const

const authorizationIdPattern = /^[A-Za-z0-9_-]{16,128}$/u
const cookieNamePattern = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]{1,128}$/u
const maximumCookieValueBytes = 16 * 1024
const maximumCookieBytes = 32 * 1024

export type GenerationOutput = "image" | "video"
export type GenerationReferenceRole =
  | "reference_image"
  | "reference_video"
  | "first_frame"
  | "last_frame"
  | "audio"
  | "text"

export interface FileGenerationReference {
  kind: "file"
  mime_type: string
  name: string
  node_id: string
  path: string
  role: GenerationReferenceRole
}

export interface TextGenerationReference {
  kind: "text"
  node_id: string
  role: "text"
  text: string
}

export type GenerationReference = FileGenerationReference | TextGenerationReference

export interface GenerationCall {
  operation_id: string
  output: GenerationOutput
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

export interface PluginServiceBrowserAuthorizationRequest {
  authorization_id: string
  cookie_names: string[]
  cookie_origin: string
  login_url: string
  schema: typeof pluginServiceBrowserAuthorizationSchema
  timeout_seconds?: number
}

export interface PluginServiceBrowserAuthorizationCompletion {
  authorization_id: string
  cookie_origin: string
  cookies: Array<{ name: string; value: string }>
  schema: typeof pluginServiceBrowserAuthorizationCompletionSchema
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
  structuredContent?:
    | { artifacts: GenerationArtifact[] }
    | PluginServiceBrowserAuthorizationRequest
    | PluginServiceStatus
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[], label: string) {
  const expected = new Set(keys)
  if (Object.keys(value).length !== keys.length || Object.keys(value).some((key) => !expected.has(key))) {
    throw new Error(`${label} contains unsupported fields`)
  }
}

function canonicalHttpsOrigin(value: unknown) {
  if (typeof value !== "string" || value.length > 2_048) {
    throw new Error("browser authorization cookie_origin is invalid")
  }
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error("browser authorization cookie_origin is invalid")
  }
  if (
    url.protocol !== "https:"
    || url.origin !== value
    || url.username !== ""
    || url.password !== ""
  ) {
    throw new Error("browser authorization cookie_origin is invalid")
  }
  return value
}

export function parsePluginServiceBrowserAuthorizationCompletion(
  value: unknown,
): PluginServiceBrowserAuthorizationCompletion {
  const input = asRecord(value, "browser authorization completion")
  exactKeys(
    input,
    ["authorization_id", "cookie_origin", "cookies", "schema"],
    "browser authorization completion",
  )
  if (input.schema !== pluginServiceBrowserAuthorizationCompletionSchema) {
    throw new Error("browser authorization completion schema is not supported")
  }
  if (typeof input.authorization_id !== "string" || !authorizationIdPattern.test(input.authorization_id)) {
    throw new Error("browser authorization id is invalid")
  }
  if (!Array.isArray(input.cookies) || input.cookies.length === 0 || input.cookies.length > 32) {
    throw new Error("browser authorization cookies are invalid")
  }
  const names = new Set<string>()
  let valueBytes = 0
  const cookies = input.cookies.map((raw) => {
    const cookie = asRecord(raw, "browser authorization cookie")
    exactKeys(cookie, ["name", "value"], "browser authorization cookie")
    if (typeof cookie.name !== "string" || !cookieNamePattern.test(cookie.name) || names.has(cookie.name)) {
      throw new Error("browser authorization cookie name is invalid")
    }
    if (
      typeof cookie.value !== "string"
      || cookie.value.length === 0
      || /[\u0000-\u0020\u007f;]/u.test(cookie.value)
    ) {
      throw new Error("browser authorization cookie value is invalid")
    }
    const cookieValueBytes = Buffer.byteLength(cookie.value, "utf8")
    if (cookieValueBytes > maximumCookieValueBytes) {
      throw new Error("browser authorization cookie is too large")
    }
    valueBytes += Buffer.byteLength(cookie.name, "utf8") + cookieValueBytes
    if (valueBytes > maximumCookieBytes) {
      throw new Error("browser authorization cookies are too large")
    }
    names.add(cookie.name)
    return { name: cookie.name, value: cookie.value }
  })
  return {
    authorization_id: input.authorization_id,
    cookie_origin: canonicalHttpsOrigin(input.cookie_origin),
    cookies,
    schema: pluginServiceBrowserAuthorizationCompletionSchema,
  }
}

export function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`)
  }
  return value as Record<string, unknown>
}

function requireTrimmedString(value: unknown, label: string, maxLength: number) {
  if (
    typeof value !== "string"
    || value.length === 0
    || value.length > maxLength
    || value !== value.trim()
    || /[\u0000-\u001f\u007f]/.test(value)
  ) {
    throw new Error(`${label} must be a non-empty trimmed string`)
  }
  return value
}

function requireTrimmedText(value: unknown, label: string, maxLength: number) {
  if (
    typeof value !== "string"
    || value.length === 0
    || value.length > maxLength
    || value !== value.trim()
    || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value)
  ) {
    throw new Error(`${label} must be non-empty trimmed text`)
  }
  return value
}

const referenceRoles = new Set<GenerationReferenceRole>([
  "reference_image",
  "reference_video",
  "first_frame",
  "last_frame",
  "audio",
  "text",
])

export function parseGenerationCall(value: unknown, expectedOutput: GenerationOutput): GenerationCall {
  const input = asRecord(value, "generation call")
  const allowedKeys = new Set([
    "schema",
    "operation_id",
    "prompt",
    "output",
    "output_directory",
    "references",
  ])
  const unknown = Object.keys(input).find((key) => !allowedKeys.has(key))
  if (unknown) throw new Error(`generation call contains unsupported field: ${unknown}`)
  if (input.schema !== generationCallSchema) throw new Error("generation call schema is not supported")
  if (input.output !== expectedOutput) throw new Error("generation call output does not match the selected tool")
  if (!Array.isArray(input.references) || input.references.length > 16) {
    throw new Error("generation references must be an array with at most 16 entries")
  }
  const references = input.references.map((value, index): GenerationReference => {
    const reference = asRecord(value, `generation reference ${index}`)
    const role = reference.role
    if (typeof role !== "string" || !referenceRoles.has(role as GenerationReferenceRole)) {
      throw new Error(`generation reference ${index} has an unsupported role`)
    }
    const nodeId = requireTrimmedString(reference.node_id, `generation reference ${index} node_id`, 256)
    if (reference.kind === "text") {
      const text = requireTrimmedText(reference.text, `generation reference ${index} text`, 200_000)
      if (role !== "text") throw new Error("text generation references must use the text role")
      return { kind: "text", node_id: nodeId, role: "text", text }
    }
    if (reference.kind !== "file") throw new Error(`generation reference ${index} kind is not supported`)
    if (role === "text") throw new Error("file generation references cannot use the text role")
    return {
      kind: "file",
      mime_type: requireTrimmedString(reference.mime_type, `generation reference ${index} mime_type`, 256),
      name: requireTrimmedString(reference.name, `generation reference ${index} name`, 512),
      node_id: nodeId,
      path: requireTrimmedString(reference.path, `generation reference ${index} path`, 4_096),
      role: role as GenerationReferenceRole,
    }
  })
  return {
    operation_id: requireTrimmedString(input.operation_id, "generation operation_id", 256),
    output: expectedOutput,
    output_directory: requireTrimmedString(input.output_directory, "generation output_directory", 4_096),
    prompt: requireTrimmedText(input.prompt, "generation prompt", 20_000),
    references,
    schema: generationCallSchema,
  }
}
