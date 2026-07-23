import type { CodexAppServerClient } from "./app-server-client.ts"
import {
  codexLlmModelIds,
  pluginServiceStatusSchema,
  type PluginServiceStatus,
} from "./contracts.ts"
import type { CodexRuntime } from "./runtime.ts"

const unavailable = { availability: "unavailable" } as const
const metadataTimeoutMs = 10_000

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function disconnected(verification: PluginServiceStatus["credential"]["verification"] = "unknown"): PluginServiceStatus {
  return {
    account: unavailable,
    credential: { configured: false, verification },
    credits: unavailable,
    schema: pluginServiceStatusSchema,
    state: "disconnected",
    usage: unavailable,
  }
}

function displayAccount(account: Record<string, unknown>) {
  if (account.type === "chatgpt" && typeof account.email === "string" && account.email.length <= 320) {
    return { availability: "available" as const, displayName: account.email }
  }
  if (account.type === "chatgpt" && typeof account.planType === "string") {
    return {
      availability: "available" as const,
      displayName: `ChatGPT ${account.planType}`.slice(0, 120),
    }
  }
  if (account.type === "apiKey") {
    return { availability: "available" as const, displayName: "OpenAI API key" }
  }
  return unavailable
}

function boundedPercentage(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 100
    ? value
    : undefined
}

function usageFor(rateLimits: Record<string, unknown> | undefined): PluginServiceStatus["usage"] {
  const primary = record(rateLimits?.primary)
  const consumed = boundedPercentage(primary?.usedPercent)
  if (consumed === undefined) return unavailable
  const duration = primary?.windowDurationMins
  const resetsAt = primary?.resetsAt
  const details = [
    typeof duration === "number" && Number.isSafeInteger(duration) && duration > 0
      ? `${duration} minute window`
      : undefined,
    typeof resetsAt === "number" && Number.isSafeInteger(resetsAt) && resetsAt > 0
      ? `resets ${new Date(resetsAt * 1_000).toISOString()}`
      : undefined,
  ].filter(Boolean).join(", ")
  return {
    availability: "available",
    consumed,
    ...(details ? { period: details.slice(0, 120) } : {}),
    unit: "% of Codex quota",
  }
}

function creditsFor(rateLimits: Record<string, unknown> | undefined): PluginServiceStatus["credits"] {
  const credits = record(rateLimits?.credits)
  if (!credits || credits.unlimited === true || credits.hasCredits !== true || typeof credits.balance !== "string") {
    return unavailable
  }
  const remaining = Number(credits.balance)
  return Number.isFinite(remaining) && remaining >= 0
    ? { availability: "available", remaining, unit: "Codex credits" }
    : unavailable
}

async function inspect(client: CodexAppServerClient): Promise<PluginServiceStatus> {
  const [accountResult, rateResult, modelResult, capabilityResult] = await Promise.all([
    client.request("account/read", { refreshToken: false }, { timeoutMs: metadataTimeoutMs }),
    client.request("account/rateLimits/read", undefined, { timeoutMs: metadataTimeoutMs }).catch(() => undefined),
    client.request("model/list", { includeHidden: true, limit: 100 }, { timeoutMs: metadataTimeoutMs }),
    client.request("modelProvider/capabilities/read", {}, { timeoutMs: metadataTimeoutMs }),
  ])
  const account = record(record(accountResult)?.account)
  if (!account) return disconnected("verified")
  const models = Array.isArray(record(modelResult)?.data) ? record(modelResult)?.data as unknown[] : []
  const availableIds = new Set(models.map((model) => record(model)?.id).filter((id): id is string => typeof id === "string"))
  const capabilities = record(capabilityResult)
  const catalogReady = [...codexLlmModelIds].every((id) => availableIds.has(id))
  const imageReady = capabilities?.imageGeneration === true
  const rateLimits = record(record(rateResult)?.rateLimits)
  return {
    account: displayAccount(account),
    credential: { configured: true, verification: catalogReady && imageReady ? "verified" : "unverified" },
    credits: creditsFor(rateLimits),
    schema: pluginServiceStatusSchema,
    state: catalogReady && imageReady ? "connected" : "attention",
    usage: usageFor(rateLimits),
  }
}

export class CodexPluginService {
  constructor(private readonly runtime: CodexRuntime) {}

  async status() {
    try {
      return await inspect(await this.runtime.client())
    } catch {
      return disconnected("failed")
    }
  }

  async authorize() {
    try {
      await this.runtime.rebind()
    } catch {
      return disconnected("failed")
    }
    return await this.status()
  }

  async reauthorize() {
    return await this.authorize()
  }
}
