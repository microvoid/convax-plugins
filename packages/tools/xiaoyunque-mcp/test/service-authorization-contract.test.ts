import { describe, expect, test } from "bun:test"
import {
  parsePluginServiceBrowserAuthorizationCompletion,
  pluginServiceBrowserAuthorizationCompletionSchema,
} from "../src/contracts.ts"

const authorizationId = "authorization_1234567890-safe"

function completion(overrides: Record<string, unknown> = {}) {
  return {
    authorization_id: authorizationId,
    cookie_origin: "https://xyq.jianying.com",
    cookies: [{ name: "sessionid_pippitcn_web", value: "private-cookie-value" }],
    schema: pluginServiceBrowserAuthorizationCompletionSchema,
    ...overrides,
  }
}

describe("Plugin service browser authorization completion contract", () => {
  test("accepts only the exact canonical bounded envelope", () => {
    expect(parsePluginServiceBrowserAuthorizationCompletion(completion())).toEqual(completion())
    expect(parsePluginServiceBrowserAuthorizationCompletion(completion({
      cookies: [
        { name: "sessionid_pippitcn_web", value: "primary-cookie" },
        { name: "sessionid_ss_pippitcn_web", value: "secure-cookie" },
      ],
    }))).toEqual(completion({
      cookies: [
        { name: "sessionid_pippitcn_web", value: "primary-cookie" },
        { name: "sessionid_ss_pippitcn_web", value: "secure-cookie" },
      ],
    }))
  })

  test("rejects unknown fields, duplicate names, noncanonical origins, and unsafe values", () => {
    for (const invalid of [
      { ...completion(), extra: true },
      completion({ authorization_id: "too-short" }),
      completion({ cookie_origin: "https://xyq.jianying.com/" }),
      completion({ cookie_origin: "http://xyq.jianying.com" }),
      completion({ cookies: [] }),
      completion({ cookies: [
        { name: "sessionid_pippitcn_web", value: "one" },
        { name: "sessionid_pippitcn_web", value: "two" },
      ] }),
      completion({ cookies: [{ name: "sessionid_pippitcn_web", value: "header;injection" }] }),
      completion({ cookies: [{ name: "sessionid_pippitcn_web", value: "x".repeat(16 * 1024 + 1) }] }),
      completion({ schema: "convax.plugin-service-browser-authorization-completion/2" }),
    ]) {
      expect(() => parsePluginServiceBrowserAuthorizationCompletion(invalid)).toThrow()
    }
  })
})
