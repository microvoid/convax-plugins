import { describe, expect, test } from "bun:test"
import { networkAddressIsPublic, openSafeDownload } from "../src/safe-download.ts"

describe("safe artifact download", () => {
  test("classifies private, loopback, link-local, and public addresses", () => {
    for (const address of [
      "127.0.0.1",
      "10.0.0.1",
      "169.254.169.254",
      "172.16.0.1",
      "192.168.1.1",
      "::1",
      "::127.0.0.1",
      "::ffff:7f00:1",
      "64:ff9b::7f00:1",
      "64:ff9b:1::7f00:1",
      "2002:7f00:1::",
      "fec0::1",
      "fd00::1",
      "fe80::1",
    ]) {
      expect(networkAddressIsPublic(address)).toBeFalse()
    }
    expect(networkAddressIsPublic("1.1.1.1")).toBeTrue()
    expect(networkAddressIsPublic("2606:4700:4700::1111")).toBeTrue()
  })

  test("rejects a private production target before making a request", async () => {
    let fetchCount = 0
    await expect(openSafeDownload("https://127.0.0.1/artifact.png", {
      allowLoopbackTest: false,
      fetch: (async () => {
        fetchCount += 1
        return new Response()
      }) as unknown as typeof fetch,
      signal: new AbortController().signal,
    })).rejects.toThrow("private network")
    expect(fetchCount).toBe(0)

    await expect(openSafeDownload("https://[::ffff:7f00:1]/artifact.png", {
      allowLoopbackTest: false,
      fetch: (async () => {
        fetchCount += 1
        return new Response()
      }) as unknown as typeof fetch,
      signal: new AbortController().signal,
    })).rejects.toThrow("private network")
    expect(fetchCount).toBe(0)
  })

  test("validates every redirect before following it", async () => {
    let fetchCount = 0
    await expect(openSafeDownload("http://127.0.0.1/start", {
      allowLoopbackTest: true,
      fetch: (async () => {
        fetchCount += 1
        return new Response(null, { status: 302, headers: { Location: "http://169.254.169.254/latest" } })
      }) as unknown as typeof fetch,
      signal: new AbortController().signal,
    })).rejects.toThrow("loopback")
    expect(fetchCount).toBe(1)
  })
})
