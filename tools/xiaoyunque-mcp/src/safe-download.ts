import { lookup } from "node:dns/promises"
import https from "node:https"
import net from "node:net"
import type { IncomingMessage } from "node:http"

const nonPublicIpv6Addresses = new net.BlockList()

for (const [address, prefix] of [
  ["::", 96],
  ["::ffff:0:0", 96],
  ["::ffff:0:0:0", 96],
  ["64:ff9b::", 96],
  ["64:ff9b:1::", 48],
  ["100::", 64],
  ["2001::", 32],
  ["2001:2::", 48],
  ["2001:10::", 28],
  ["2001:20::", 28],
  ["2001:db8::", 32],
  ["2002::", 16],
  ["3fff::", 20],
  ["5f00::", 16],
  ["fc00::", 7],
  ["fe80::", 10],
  ["fec0::", 10],
  ["ff00::", 8],
] as const) {
  nonPublicIpv6Addresses.addSubnet(address, prefix, "ipv6")
}

export interface SafeDownload {
  contentLength: number | null
  stream: AsyncIterable<Uint8Array>
}

interface OpenSafeDownloadOptions {
  allowLoopbackTest: boolean
  fetch: typeof fetch
  signal: AbortSignal
}

function ipv4IsPublic(address: string) {
  const parts = address.split(".").map(Number)
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false
  const [a, b] = parts as [number, number, number, number]
  return !(
    a === 0
    || a === 10
    || a === 127
    || a >= 224
    || a === 100 && b >= 64 && b <= 127
    || a === 169 && b === 254
    || a === 172 && b >= 16 && b <= 31
    || a === 192 && (b === 0 || b === 168)
    || a === 198 && (b === 18 || b === 19 || b === 51)
    || a === 203 && b === 0
  )
}

function ipv6IsPublic(address: string) {
  const normalized = address.toLowerCase().split("%", 1)[0]!
  return !nonPublicIpv6Addresses.check(normalized, "ipv6")
}

export function networkAddressIsPublic(address: string) {
  const family = net.isIP(address)
  return family === 4 ? ipv4IsPublic(address) : family === 6 ? ipv6IsPublic(address) : false
}

function normalizedHostname(hostname: string) {
  const withoutTrailingDot = hostname.toLowerCase().replace(/\.$/, "")
  return withoutTrailingDot.startsWith("[") && withoutTrailingDot.endsWith("]")
    ? withoutTrailingDot.slice(1, -1)
    : withoutTrailingDot
}

function validateUrl(url: URL, allowLoopbackTest: boolean) {
  if (url.username || url.password) throw new Error("XiaoYunque artifact URL cannot contain credentials")
  if (allowLoopbackTest) {
    if ((url.protocol !== "http:" && url.protocol !== "https:") || url.hostname !== "127.0.0.1") {
      throw new Error("Test artifact URL must stay on loopback")
    }
    return
  }
  if (url.protocol !== "https:" || url.port && url.port !== "443") {
    throw new Error("XiaoYunque artifact URL must use standard HTTPS")
  }
  const hostname = normalizedHostname(url.hostname)
  if (hostname === "localhost" || hostname.endsWith(".localhost") || hostname.endsWith(".local")) {
    throw new Error("XiaoYunque artifact URL cannot target a local host")
  }
  if (net.isIP(hostname) && !networkAddressIsPublic(hostname)) {
    throw new Error("XiaoYunque artifact URL cannot target a private network")
  }
}

async function webStream(response: Response): Promise<AsyncIterable<Uint8Array>> {
  if (!response.body) throw new Error("XiaoYunque artifact response had no body")
  const reader = response.body.getReader()
  return {
    async *[Symbol.asyncIterator]() {
      while (true) {
        const { done, value } = await reader.read()
        if (done) return
        yield value
      }
    },
  }
}

async function openLoopback(
  initialUrl: URL,
  options: OpenSafeDownloadOptions,
): Promise<SafeDownload> {
  let url = initialUrl
  for (let redirects = 0; redirects <= 5; redirects += 1) {
    validateUrl(url, true)
    const response = await options.fetch(url, { redirect: "manual", signal: options.signal })
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location")
      if (!location || redirects === 5) throw new Error("XiaoYunque artifact redirect was rejected")
      url = new URL(location, url)
      continue
    }
    if (!response.ok) throw new Error("Unable to download the XiaoYunque artifact")
    const contentLength = Number(response.headers.get("content-length") ?? "")
    return {
      contentLength: Number.isFinite(contentLength) && contentLength >= 0 ? contentLength : null,
      stream: await webStream(response),
    }
  }
  throw new Error("XiaoYunque artifact redirected too many times")
}

async function pinnedHttpsRequest(url: URL, signal: AbortSignal): Promise<IncomingMessage> {
  const addresses = await lookup(normalizedHostname(url.hostname), { all: true, verbatim: true })
  if (addresses.length === 0 || addresses.some((entry) => !networkAddressIsPublic(entry.address))) {
    throw new Error("XiaoYunque artifact host resolved to a private network")
  }
  const selected = addresses[0]!
  return new Promise<IncomingMessage>((resolve, reject) => {
    const request = https.get(url, {
      headers: { Accept: "image/*, video/*;q=0.9, application/octet-stream;q=0.1" },
      lookup: (_hostname, options, callback) => {
        if (typeof options === "object" && options.all) callback(null, [selected])
        else callback(null, selected.address, selected.family)
      },
      signal,
    }, resolve)
    request.once("error", reject)
  })
}

async function openPublicHttps(initialUrl: URL, signal: AbortSignal): Promise<SafeDownload> {
  let url = initialUrl
  for (let redirects = 0; redirects <= 5; redirects += 1) {
    validateUrl(url, false)
    const response = await pinnedHttpsRequest(url, signal)
    const status = response.statusCode ?? 0
    if (status >= 300 && status < 400) {
      const location = response.headers.location
      response.resume()
      if (!location || redirects === 5) throw new Error("XiaoYunque artifact redirect was rejected")
      url = new URL(location, url)
      continue
    }
    if (status < 200 || status >= 300) {
      response.resume()
      throw new Error("Unable to download the XiaoYunque artifact")
    }
    const contentLength = Number(response.headers["content-length"] ?? "")
    return {
      contentLength: Number.isFinite(contentLength) && contentLength >= 0 ? contentLength : null,
      stream: response,
    }
  }
  throw new Error("XiaoYunque artifact redirected too many times")
}

export async function openSafeDownload(rawUrl: string, options: OpenSafeDownloadOptions) {
  const url = new URL(rawUrl)
  return options.allowLoopbackTest
    ? openLoopback(url, options)
    : openPublicHttps(url, options.signal)
}
