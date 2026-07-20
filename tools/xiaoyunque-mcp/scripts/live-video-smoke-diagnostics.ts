import {
  safeGenerationDiagnosticCodes,
  type SafeGenerationDiagnosticCode,
} from "../src/mcp-server.ts"

export type { SafeGenerationDiagnosticCode } from "../src/mcp-server.ts"

const safeGenerationDiagnosticCodeSet: ReadonlySet<string> = new Set(
  safeGenerationDiagnosticCodes,
)
const generationFailureLine = /^\[xiaoyunque\] generation failed \(([a-z]+(?:-[a-z]+)*)\)$/
const liveVideoOperationId = /^live-video-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u

/**
 * Accept only the sidecar's complete fixed diagnostic line. Unknown categories,
 * prefixes, suffixes, and multiline content are deliberately ignored so the
 * live smoke never becomes a channel for upstream stderr.
 */
export function parseSafeGenerationFailureLine(
  line: string,
): SafeGenerationDiagnosticCode | undefined {
  const match = generationFailureLine.exec(line)
  const category = match?.[1]
  return category && safeGenerationDiagnosticCodeSet.has(category)
    ? category as SafeGenerationDiagnosticCode
    : undefined
}

export function formatSafeGenerationFailure(category: SafeGenerationDiagnosticCode) {
  return JSON.stringify({
    category,
    stage: "generation.submit-and-wait",
    status: "failed",
  })
}

export function formatSafeGenerationOperation(operationId: string) {
  if (!liveVideoOperationId.test(operationId)) {
    throw new Error("Live video operation id is invalid")
  }
  return JSON.stringify({
    operation_id: operationId,
    stage: "generation.submit-and-wait",
    status: "running",
  })
}
