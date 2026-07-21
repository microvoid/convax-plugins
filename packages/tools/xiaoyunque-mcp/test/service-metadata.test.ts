import { describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import {
  XiaoYunqueServiceMetadataClient,
  XiaoYunqueServiceSessionExpiredError,
  xiaoYunqueServiceEndpoints,
} from "../src/service-metadata.ts"
import { webSessionSchema, type StoredWebSession } from "../src/web-session-store.ts"

const fixedNow = Date.UTC(2026, 6, 19, 0, 0, 0)

function session(): StoredWebSession {
  return {
    authorizedAt: fixedNow,
    cookies: [{
      domain: "",
      expiresAt: fixedNow + 60_000,
      name: "sessionid_pippitcn_web",
      path: "/",
      secure: true,
      value: "private-live-metadata-session",
    }],
    revision: "12345678-1234-1234-9234-123456789abc",
    schema: webSessionSchema,
  }
}

function json(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), {
    headers: { "Content-Type": "application/json" },
    status,
  })
}

function urlOf(input: string | URL | Request) {
  return typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url
}

function standardPayload(url: string) {
  if (url === xiaoYunqueServiceEndpoints.account) {
    return { data: { name: "小云雀用户" }, ret: "0" }
  }
  if (url === xiaoYunqueServiceEndpoints.credits) {
    return {
      data: {
        credit: {
          free_credits: 4,
          gift_credit: 2,
          purchase_credit: "3",
          vip_credit: "10",
        },
      },
      ret: "0",
    }
  }
  if (url === xiaoYunqueServiceEndpoints.history) {
    return {
      data: {
        has_more: false,
        new_cursor: "wire-cursor",
        records: [
          { amount: "-7", history_type: 2, status: "Checked" },
          { amount: -99, history_type: 2, status: "Init" },
          { amount: -11, history_type: 2, status: "CheckFailed" },
          { amount: -12, history_type: 2, status: "Canceled" },
          { amount: 3, history_type: "2", status: "Checked" },
        ],
        total_credit: "19",
      },
      ret: "0",
    }
  }
  throw new Error("unexpected URL")
}

describe("XiaoYunque live service metadata", () => {
  test("uses the exact first-party endpoint-specific headers and reports honest bounded metrics", async () => {
    const calls: Array<{ init: Parameters<typeof fetch>[1]; url: string }> = []
    const client = new XiaoYunqueServiceMetadataClient({
      fetchImpl: (async (input, init) => {
        const url = urlOf(input)
        calls.push({ init, url })
        return json(standardPayload(url))
      }) as typeof fetch,
      now: () => fixedNow,
    })

    expect(await client.read(session())).toEqual({
      consumed: 10,
      displayName: "小云雀用户",
      remaining: 19,
    })
    expect(calls.map(({ url }) => url)).toEqual([
      xiaoYunqueServiceEndpoints.account,
      xiaoYunqueServiceEndpoints.credits,
      xiaoYunqueServiceEndpoints.history,
    ])
    const accountHeaders = new Headers(calls[0]?.init?.headers)
    expect(accountHeaders.get("appid")).toBe("795647")
    expect(accountHeaders.get("entrance-from")).toBe("web")
    expect(accountHeaders.get("pf")).toBe("7")
    expect(accountHeaders.get("appvr")).toBe("1.1.4")
    expect(accountHeaders.get("sign")).toBeNull()
    expect(accountHeaders.get("loc")).toBeNull()
    expect(accountHeaders.get("cookie")).toBe("sessionid_pippitcn_web=private-live-metadata-session")

    const deviceTime = Math.floor(fixedNow / 1_000)
    for (const [index, suffix] of [[1, "_credit"], [2, "history"]] as const) {
      const headers = new Headers(calls[index]?.init?.headers)
      expect(headers.get("loc")).toBe("CN")
      expect(headers.get("appvr")).toBe("5.8.0")
      expect(headers.get("sign-ver")).toBe("1")
      expect(headers.get("device-time")).toBe(String(deviceTime))
      expect(headers.get("sign")).toBe(createHash("md5")
        .update(`9e2c|${suffix}|7|5.8.0|${deviceTime}||11ac`)
        .digest("hex"))
      expect(calls[index]?.init?.redirect).toBe("error")
    }
    expect(JSON.parse(String(calls[1]?.init?.body))).toEqual({})
    expect(JSON.parse(String(calls[2]?.init?.body))).toEqual({
      count: 20,
      history_type: 2,
      need_with_hold: false,
    })
  })

  test("publishes zero only for an explicit empty history page", async () => {
    for (const records of [[], undefined] as const) {
      const client = new XiaoYunqueServiceMetadataClient({
        fetchImpl: (async (input) => {
          const url = urlOf(input)
          return json(url === xiaoYunqueServiceEndpoints.history
            ? { data: records === undefined ? {} : { records }, ret: "0" }
            : standardPayload(url))
        }) as typeof fetch,
        now: () => fixedNow,
      })

      expect((await client.read(session())).consumed).toBe(records === undefined ? null : 0)
    }
  })

  test("does not publish partial usage when consumption records have missing or unknown status", async () => {
    for (const status of [undefined, "FutureStatus"] as const) {
      const client = new XiaoYunqueServiceMetadataClient({
        fetchImpl: (async (input) => {
          const url = urlOf(input)
          return json(url === xiaoYunqueServiceEndpoints.history
            ? {
                data: { records: [{ amount: -7, history_type: 2, ...(status === undefined ? {} : { status }) }] },
                ret: "0",
              }
            : standardPayload(url))
        }) as typeof fetch,
        now: () => fixedNow,
      })

      expect((await client.read(session())).consumed).toBeNull()
    }
  })

  test("degrades optional account metadata without hiding valid credits and usage", async () => {
    const client = new XiaoYunqueServiceMetadataClient({
      fetchImpl: (async (input) => {
        const url = urlOf(input)
        return url === xiaoYunqueServiceEndpoints.account
          ? json({ errmsg: "bounded failure", ret: "500" }, 500)
          : json(standardPayload(url))
      }) as typeof fetch,
      now: () => fixedNow,
    })

    expect(await client.read(session())).toEqual({
      consumed: 10,
      displayName: null,
      remaining: 19,
    })
  })

  test("classifies HTTP 401 and ret=1015 as reauthorization attention", async () => {
    for (const mode of ["http", "ret"] as const) {
      const client = new XiaoYunqueServiceMetadataClient({
        fetchImpl: (async (input) => {
          const url = urlOf(input)
          if (mode === "http" && url === xiaoYunqueServiceEndpoints.account) return new Response(null, { status: 401 })
          if (mode === "ret" && url === xiaoYunqueServiceEndpoints.credits) return json({ ret: 1015 })
          return json(standardPayload(url))
        }) as typeof fetch,
        now: () => fixedNow,
      })

      await expect(client.read(session())).rejects.toBeInstanceOf(XiaoYunqueServiceSessionExpiredError)
    }
  })

  test("degrades malformed balance and history responses independently", async () => {
    const remoteSecret = "remote-response-secret-must-not-escape"
    for (const mode of ["body", "records", "remote"] as const) {
      const client = new XiaoYunqueServiceMetadataClient({
        fetchImpl: (async (input) => {
          const url = urlOf(input)
          if (url === xiaoYunqueServiceEndpoints.credits && mode === "body") {
            return new Response(JSON.stringify({ padding: "x".repeat(257 * 1024), ret: 0 }))
          }
          if (url === xiaoYunqueServiceEndpoints.history && mode === "records") {
            return json({ data: { records: Array.from({ length: 21 }, () => ({})) }, ret: 0 })
          }
          if (url === xiaoYunqueServiceEndpoints.credits && mode === "remote") {
            return json({ errmsg: remoteSecret, ret: 500 }, 500)
          }
          return json(standardPayload(url))
        }) as typeof fetch,
        now: () => fixedNow,
      })

      const metadata = await client.read(session())
      expect(metadata).toEqual(mode === "records"
        ? { consumed: null, displayName: "小云雀用户", remaining: 19 }
        : { consumed: 10, displayName: "小云雀用户", remaining: null })
      expect(JSON.stringify(metadata)).not.toContain(remoteSecret)
    }
  })

  test("returns one bounded error without remote diagnostics when every metadata surface fails", async () => {
    const remoteSecret = "remote-response-secret-must-not-escape"
    const client = new XiaoYunqueServiceMetadataClient({
      fetchImpl: (async (_input) => json({ errmsg: remoteSecret, ret: 500 }, 500)) as typeof fetch,
      now: () => fixedNow,
    })

    let failure: unknown
    try {
      await client.read(session())
    } catch (error) {
      failure = error
    }
    expect(failure).toMatchObject({ name: "XiaoYunqueServiceMetadataError" })
    expect(String(failure)).not.toContain(remoteSecret)
    expect(JSON.stringify(failure)).not.toContain(remoteSecret)
  })

  test("honors caller cancellation", async () => {
    const controller = new AbortController()
    const client = new XiaoYunqueServiceMetadataClient({
      fetchImpl: ((_, init) => new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), {
          once: true,
        })
      })) as typeof fetch,
      now: () => fixedNow,
    })
    const reading = client.read(session(), controller.signal)
    controller.abort("private-cancel-reason")

    await expect(reading).rejects.toMatchObject({ name: "AbortError" })
  })

  test("times out and cancels an unread response body without reporting caller cancellation", async () => {
    let bodyCancelled = false
    const hangingBody = new ReadableStream<Uint8Array>({
      cancel() {
        bodyCancelled = true
      },
      pull() {
        // Deliberately never enqueue or close.
      },
    })
    const client = new XiaoYunqueServiceMetadataClient({
      fetchImpl: (async (input) => {
        const url = urlOf(input)
        if (url === xiaoYunqueServiceEndpoints.credits) return new Response(hangingBody)
        return json(standardPayload(url))
      }) as typeof fetch,
      now: () => fixedNow,
      timeoutMs: 10,
    })

    await expect(client.read(session())).resolves.toEqual({
      consumed: 10,
      displayName: "小云雀用户",
      remaining: null,
    })
    expect(bodyCancelled).toBeTrue()
  })
})
