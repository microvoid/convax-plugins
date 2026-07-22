import { describe, expect, test } from "bun:test"
import type { CodexAppServerClient } from "../src/app-server-client.ts"
import { CodexPluginService } from "../src/plugin-service.ts"
import type { CodexRuntime } from "../src/runtime.ts"

function client(responses: Record<string, unknown>) {
  return {
    async request(method: string) {
      if (!(method in responses)) throw new Error("unavailable")
      return responses[method]
    },
  } as unknown as CodexAppServerClient
}

function runtime(bound: CodexAppServerClient, rebind = bound) {
  return {
    async client() { return bound },
    async rebind() { return rebind },
  } as unknown as CodexRuntime
}

function connectedResponses() {
  return {
    "account/read": { account: { email: "person@example.com", planType: "pro", type: "chatgpt" }, requiresOpenaiAuth: true },
    "account/rateLimits/read": {
      rateLimits: {
        credits: { balance: "12.5", hasCredits: true, unlimited: false },
        primary: { resetsAt: 1_800_000_000, usedPercent: 37, windowDurationMins: 10_080 },
      },
    },
    "model/list": { data: ["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna", "gpt-5.5"].map((id) => ({ id })) },
    "modelProvider/capabilities/read": { imageGeneration: true },
  }
}

describe("Codex Plugin service", () => {
  test("projects bounded account, credit, and quota metadata", async () => {
    const status = await new CodexPluginService(runtime(client(connectedResponses()))).status()
    expect(status).toEqual({
      account: { availability: "available", displayName: "person@example.com" },
      credential: { configured: true, verification: "verified" },
      credits: { availability: "available", remaining: 12.5, unit: "Codex credits" },
      schema: "convax.plugin-service-status/1",
      state: "connected",
      usage: {
        availability: "available",
        consumed: 37,
        period: expect.stringContaining("10080 minute window"),
        unit: "% of Codex quota",
      },
    })
  })

  test("marks a logged-out or incomplete local binding honestly", async () => {
    const loggedOut = client({
      ...connectedResponses(),
      "account/read": { account: null, requiresOpenaiAuth: true },
    })
    await expect(new CodexPluginService(runtime(loggedOut)).status()).resolves.toMatchObject({
      credential: { configured: false, verification: "verified" },
      state: "disconnected",
    })

    const missingImage = client({
      ...connectedResponses(),
      "modelProvider/capabilities/read": { imageGeneration: false },
    })
    await expect(new CodexPluginService(runtime(missingImage)).status()).resolves.toMatchObject({
      credential: { configured: true, verification: "unverified" },
      state: "attention",
    })
  })

  test("authorize only re-probes the local binding", async () => {
    let rebound = 0
    const bound = client(connectedResponses())
    const fakeRuntime = {
      async client() { return bound },
      async rebind() { rebound += 1; return bound },
    } as unknown as CodexRuntime
    await expect(new CodexPluginService(fakeRuntime).authorize()).resolves.toMatchObject({ state: "connected" })
    expect(rebound).toBe(1)
  })
})
