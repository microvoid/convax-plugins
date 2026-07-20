import { describe, expect, test } from "bun:test"
import { XiaoYunqueCredentialConfigurationError } from "../src/configuration-error.ts"
import {
  XiaoYunqueGenerationInputError,
  XiaoYunqueObservationRejectedError,
  XiaoYunqueUnsupportedImageModelError,
} from "../src/generator.ts"
import { publicGenerationErrorMessage, safeGenerationDiagnosticCode } from "../src/mcp-server.ts"
import {
  XiaoYunqueAuthenticationError,
  XiaoYunqueQueryTimeoutError,
  XiaoYunqueRequestRejectedError,
} from "../src/xiaoyunque-api.ts"

describe("safe public generation errors", () => {
  test("gives fixed actionable guidance for known failure categories", () => {
    expect(publicGenerationErrorMessage(new XiaoYunqueCredentialConfigurationError()))
      .toContain("Open Convax Services")
    expect(publicGenerationErrorMessage(
      new XiaoYunqueGenerationInputError("last-frame-without-first"),
    )).toBe("A video last frame requires exactly one first frame.")
    expect(publicGenerationErrorMessage(new XiaoYunqueAuthenticationError("private upstream detail")))
      .toBe("XiaoYunque sign-in expired. Open Convax Services and reconnect XiaoYunque.")
    expect(publicGenerationErrorMessage(new XiaoYunqueQueryTimeoutError("private timeout detail")))
      .toBe(
        "XiaoYunque accepted the generation, but repeated status checks timed out. It was not resubmitted; check XiaoYunque before starting another paid generation.",
      )
    expect(publicGenerationErrorMessage(new XiaoYunqueObservationRejectedError("upstream-http-rejected")))
      .toBe(
        "XiaoYunque accepted the generation, but repeated status checks were rejected. It was not resubmitted; check XiaoYunque before starting another paid generation.",
      )
    expect(publicGenerationErrorMessage(new XiaoYunqueUnsupportedImageModelError()))
      .toBe(
        "The selected XiaoYunque image model is no longer available. Choose another image model and try again.",
      )
    expect(publicGenerationErrorMessage(new XiaoYunqueRequestRejectedError("private rejection detail")))
      .toBe(
        "XiaoYunque did not accept this generation request. Refresh Services and try a model listed for this capability.",
      )
  })

  test("keeps known guidance compatible with the host diagnostic safety filter", () => {
    const messages = [
      publicGenerationErrorMessage(new XiaoYunqueCredentialConfigurationError()),
      publicGenerationErrorMessage(new XiaoYunqueAuthenticationError()),
      publicGenerationErrorMessage(new XiaoYunqueObservationRejectedError("upstream-envelope-rejected")),
      publicGenerationErrorMessage(new XiaoYunqueQueryTimeoutError()),
      publicGenerationErrorMessage(new XiaoYunqueRequestRejectedError("private rejection detail")),
      publicGenerationErrorMessage(new XiaoYunqueUnsupportedImageModelError()),
    ]
    const forbiddenDiagnostic = /\b(?:authorization|cookie|set-cookie|password|passwd|secret|api[-_ ]?key|access[-_ ]?key|secret[-_ ]?key|token|ak|sk)\b/i
    for (const message of messages) expect(message).not.toMatch(forbiddenDiagnostic)
  })

  test("never forwards an unknown error message", () => {
    const privateDetail = "Cookie=session-secret /Users/private/input.png https://private.invalid/task"
    const message = publicGenerationErrorMessage(new Error(privateDetail))

    expect(message).toBe("XiaoYunque generation failed.")
    expect(message).not.toContain(privateDetail)
    expect(message).not.toContain("session-secret")
  })

  test("emits only fixed non-secret diagnostic categories", () => {
    const privateDetail = "Cookie=session-secret /Users/private/input.png https://private.invalid/task"
    const categories = [
      safeGenerationDiagnosticCode(new XiaoYunqueAuthenticationError(privateDetail)),
      safeGenerationDiagnosticCode(new XiaoYunqueObservationRejectedError("upstream-http-rejected")),
      safeGenerationDiagnosticCode(new XiaoYunqueQueryTimeoutError(privateDetail)),
      safeGenerationDiagnosticCode(new XiaoYunqueUnsupportedImageModelError()),
      safeGenerationDiagnosticCode(new XiaoYunqueRequestRejectedError(
        privateDetail,
        "upstream-envelope-rejected",
      )),
      safeGenerationDiagnosticCode(new Error(privateDetail)),
    ]

    expect(categories).toEqual([
      "sign-in-expired",
      "status-check-rejected",
      "status-check-timeout",
      "unsupported-image-model",
      "upstream-envelope-rejected",
      "unclassified-failure",
    ])
    expect(JSON.stringify(categories)).not.toContain(privateDetail)
    expect(JSON.stringify(categories)).not.toContain("session-secret")
  })
})
