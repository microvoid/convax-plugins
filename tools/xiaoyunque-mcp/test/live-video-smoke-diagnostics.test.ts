import { describe, expect, test } from "bun:test"
import {
  formatSafeGenerationFailure,
  formatSafeGenerationOperation,
  parseSafeGenerationFailureLine,
} from "../scripts/live-video-smoke-diagnostics.ts"
import { safeGenerationDiagnosticCodes } from "../src/mcp-server.ts"

describe("live video smoke diagnostics", () => {
  test("accepts only complete sidecar generation failure lines with fixed categories", () => {
    for (const category of safeGenerationDiagnosticCodes) {
      expect(parseSafeGenerationFailureLine(
        `[xiaoyunque] generation failed (${category})`,
      )).toBe(category)
    }
  })

  test("drops unknown, decorated, multiline, and private stderr content", () => {
    const privateDetail = "Cookie=session-secret /Users/private/input.png https://private.invalid/task"
    const rejected = [
      "[xiaoyunque] generation failed (future-private-category)",
      `[xiaoyunque] generation failed (sign-in-expired) ${privateDetail}`,
      `prefix [xiaoyunque] generation failed (sign-in-expired)`,
      `[xiaoyunque] generation failed (sign-in-expired)\n${privateDetail}`,
      privateDetail,
    ]

    for (const line of rejected) expect(parseSafeGenerationFailureLine(line)).toBeUndefined()
  })

  test("formats a failure with only the safe category and fixed smoke metadata", () => {
    expect(formatSafeGenerationFailure("upstream-envelope-rejected")).toBe(JSON.stringify({
      category: "upstream-envelope-rejected",
      stage: "generation.submit-and-wait",
      status: "failed",
    }))
  })

  test("reports only a canonical recoverable operation id before the paid call", () => {
    const operationId = "live-video-12345678-1234-4123-8123-123456789abc"
    expect(formatSafeGenerationOperation(operationId)).toBe(JSON.stringify({
      operation_id: operationId,
      stage: "generation.submit-and-wait",
      status: "running",
    }))
    expect(() => formatSafeGenerationOperation("live-video-Cookie=session-secret"))
      .toThrow("operation id is invalid")
  })
})
