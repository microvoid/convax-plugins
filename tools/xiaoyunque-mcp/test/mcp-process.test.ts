import { afterEach, describe, expect, test } from "bun:test"
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process"
import { randomUUID } from "node:crypto"
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { createInterface } from "node:readline"
import { createServer } from "../src/index.ts"

const png = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0])
const mp4 = Uint8Array.from([0, 0, 0, 24, 102, 116, 121, 112, 105, 115, 111, 109, 0, 0, 0, 0])
const directories: string[] = []

async function accountPreflightResponse(request: Request) {
  const pathname = new URL(request.url).pathname
  if (
    pathname !== "/api/biz/v1/common/get_odin_user_info"
    && pathname !== "/api/web/v1/workspace/get_user_workspace"
  ) return undefined

  expect(request.method).toBe("POST")
  const body = await request.json()
  if (pathname === "/api/biz/v1/common/get_odin_user_info") {
    expect(body).toEqual({})
    return Response.json({ ret: 0, data: { user_id: "consumer-1" } })
  }
  expect(body).toEqual({ uid: "consumer-1" })
  return Response.json({
    ret: 0,
    data: {
      space_id: "space-1",
      workspace_id: "workspace-1",
    },
  })
}

async function submittedTask(request: Request) {
  const body = await request.json() as {
    message: { run_id: string; thread_id: string }
  }
  return {
    runId: body.message.run_id,
    threadId: body.message.thread_id,
  }
}

async function writeWebSession(configRoot: string, cookieValue: string) {
  const stateDirectory = path.join(configRoot, "convax", "xiaoyunque")
  const sessionPath = path.join(stateDirectory, "web-session.json")
  await mkdir(stateDirectory, { recursive: true, mode: 0o700 })
  await chmod(stateDirectory, 0o700)
  await writeFile(sessionPath, `${JSON.stringify({
    authorizedAt: Date.now(),
    cookies: [{
      domain: "",
      name: "sessionid_pippitcn_web",
      path: "/",
      secure: true,
      value: cookieValue,
    }],
    revision: randomUUID(),
    schema: "convax.xiaoyunque-web-session/2",
  })}\n`, { mode: 0o600 })
  await chmod(sessionPath, 0o600)
  return sessionPath
}

async function withTimeout<T>(promise: Promise<T>, milliseconds: number, message: string) {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(message)), milliseconds)
  })
  try {
    return await Promise.race([promise, timeout])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { force: true, recursive: true })))
})

class JsonRpcHarness {
  readonly stderr: Promise<string>
  readonly messages: unknown[] = []
  readonly #pending = new Map<number, (message: Record<string, unknown>) => void>()
  #nextId = 1

  constructor(readonly child: ChildProcessWithoutNullStreams) {
    const lines = createInterface({ input: child.stdout })
    lines.on("line", (line) => {
      const message = JSON.parse(line) as Record<string, unknown>
      this.messages.push(message)
      if (typeof message.id === "number") this.#pending.get(message.id)?.(message)
    })
    this.stderr = new Promise((resolve) => {
      let value = ""
      child.stderr.setEncoding("utf8")
      child.stderr.on("data", (chunk: string) => { value += chunk })
      child.stderr.on("end", () => resolve(value))
    })
  }

  request(method: string, params: unknown) {
    const id = this.#nextId++
    const response = new Promise<Record<string, unknown>>((resolve) => this.#pending.set(id, resolve))
    this.child.stdin.write(`${JSON.stringify({ id, jsonrpc: "2.0", method, params })}\n`)
    return response.finally(() => this.#pending.delete(id))
  }

  notify(method: string, params: unknown) {
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`)
  }
}

describe("MCP process", () => {
  test("never sends a Cookie session to an overridden HTTPS origin", () => {
    expect(() => createServer({
      HOME: os.homedir(),
      XYQ_BASE_URL: "https://example.com",
    })).toThrow("official HTTPS endpoint")
    expect(() => createServer({
      HOME: os.homedir(),
      XYQ_BASE_URL: "https://xyq.jianying.com.evil.test",
    })).toThrow("official HTTPS endpoint")
    expect(() => createServer({
      HOME: os.homedir(),
      XYQ_BASE_URL: "https://xyq.jianying.com/redirected-base",
    })).toThrow("official HTTPS endpoint")
  })

  test("fails fast with safe setup guidance and no API request when authorization is absent", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "xiaoyunque-mcp-no-auth-"))
    directories.push(directory)
    const configRoot = path.join(directory, "config")
    const outputDirectory = path.join(directory, "output")
    await mkdir(outputDirectory, { recursive: true })
    let requestCount = 0
    const api = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () => {
        requestCount += 1
        return new Response("unexpected", { status: 500 })
      },
    })
    const child = spawn(process.execPath, [path.join(import.meta.dir, "..", "src", "index.ts")], {
      cwd: path.join(import.meta.dir, ".."),
      env: {
        HOME: os.homedir(),
        PATH: process.env.PATH,
        XDG_CONFIG_HOME: configRoot,
        XYQ_BASE_URL: `http://127.0.0.1:${api.port}`,
        XYQ_POLL_INTERVAL_MS: "1",
      },
      stdio: ["pipe", "pipe", "pipe"],
    })
    const harness = new JsonRpcHarness(child)
    try {
      await harness.request("initialize", {
        capabilities: {},
        clientInfo: { name: "test", version: "1" },
        protocolVersion: "2025-03-26",
      })
      const generated = await withTimeout(harness.request("tools/call", {
        name: "image.seedream_4.5",
        arguments: {
          schema: "convax.generation-call/1",
          operation_id: "missing-authorization-operation",
          prompt: "Do not submit this request",
          output: "image",
          output_directory: outputDirectory,
          references: [],
        },
      }), 2_000, "missing authorization did not fail fast")
      expect(generated).toMatchObject({ result: { isError: true } })
      const text = ((generated.result as { content: Array<{ text: string }> }).content[0]?.text ?? "")
      expect(text).toContain("Open Convax Services")
      expect(text).not.toContain("Access Key is not configured")
      expect(requestCount).toBe(0)
    } finally {
      const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()))
      child.kill("SIGTERM")
      await exited
      api.stop(true)
    }
    expect(await harness.stderr).toContain("[xiaoyunque] generation failed")
  })

  test("round-trips host browser authorization without exposing or auto-fetching Cookies", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "xiaoyunque-mcp-service-"))
    directories.push(directory)
    const configRoot = path.join(directory, "config")
    const stateDirectory = path.join(configRoot, "convax", "xiaoyunque")
    const sessionPath = path.join(stateDirectory, "web-session.json")
    const privateCookie = "host-captured-session-cookie-never-rendered"
    let requestCount = 0
    const api = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: (request) => {
        requestCount += 1
        const url = new URL(request.url)
        expect(request.headers.get("cookie")).toBe(`sessionid_pippitcn_web=${privateCookie}`)
        expect(request.headers.has("authorization")).toBeFalse()
        if (url.pathname === "/api/biz/v1/user/info") {
          return Response.json({ data: { name: "小云雀测试账号" }, ret: "0" })
        }
        if (url.pathname === "/commerce/v1/benefits/user_credit") {
          return Response.json({
            data: {
              credit: {
                free_credits: 4,
                gift_credit: 2,
                purchase_credit: "3",
                vip_credit: "10",
              },
            },
            ret: "0",
          })
        }
        if (url.pathname === "/commerce/v1/benefits/user_credit_history") {
          return Response.json({
            data: {
              records: [
                { amount: "-7", history_type: 2, status: "Checked" },
                { amount: "-99", history_type: 2, status: "Init" },
              ],
            },
            ret: "0",
          })
        }
        return new Response("unexpected", { status: 500 })
      },
    })
    const child = spawn(process.execPath, [path.join(import.meta.dir, "..", "src", "index.ts")], {
      cwd: path.join(import.meta.dir, ".."),
      env: {
        HOME: os.homedir(),
        PATH: process.env.PATH,
        XDG_CONFIG_HOME: configRoot,
        XYQ_BASE_URL: `http://127.0.0.1:${api.port}`,
      },
      stdio: ["pipe", "pipe", "pipe"],
    })
    const harness = new JsonRpcHarness(child)
    try {
      const initialized = await harness.request("initialize", {
        capabilities: {},
        clientInfo: { name: "test", version: "1" },
        protocolVersion: "2025-03-26",
      })
      expect(initialized).toMatchObject({
        result: {
          serverInfo: { name: "convax-xiaoyunque-mcp", version: "0.3.0" },
        },
      })
      const authorization = await harness.request("tools/call", { name: "service.authorize", arguments: {} })
      expect(authorization).toMatchObject({
        result: {
          content: [{ text: "XiaoYunque browser authorization requested from the host.", type: "text" }],
          structuredContent: {
            cookie_names: ["sessionid_pippitcn_web", "sessionid_ss_pippitcn_web"],
            cookie_origin: "https://xyq.jianying.com",
            login_url: "https://xyq.jianying.com/login?redirect_url=%2F",
            schema: "convax.plugin-service-browser-authorization/1",
            timeout_seconds: 1_800,
          },
        },
      })
      const authorizationId = (authorization.result as {
        structuredContent: { authorization_id: string }
      }).structuredContent.authorization_id
      expect(authorizationId).toMatch(/^[A-Za-z0-9_-]{16,128}$/)
      expect(requestCount).toBe(0)

      const rejected = await harness.request("tools/call", {
        name: "service.authorization.complete",
        arguments: {
          authorization_id: authorizationId,
          cookie_origin: "https://xyq.jianying.com",
          cookies: [{ name: "passport_csrf_token", value: "must-not-store" }],
          schema: "convax.plugin-service-browser-authorization-completion/1",
        },
      })
      expect(rejected).toMatchObject({ result: { isError: true } })
      expect(requestCount).toBe(0)
      await expect(readFile(sessionPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" })

      const completed = await harness.request("tools/call", {
        name: "service.authorization.complete",
        arguments: {
          authorization_id: authorizationId,
          cookie_origin: "https://xyq.jianying.com",
          cookies: [{ name: "sessionid_pippitcn_web", value: privateCookie }],
          schema: "convax.plugin-service-browser-authorization-completion/1",
        },
      })
      expect(completed).toMatchObject({
        result: {
          content: [{ text: "XiaoYunque browser authorization stored locally.", type: "text" }],
          structuredContent: {
            account: { availability: "available", displayName: "小云雀测试账号" },
            credential: { configured: true, verification: "verified" },
            credits: { availability: "available", remaining: 19, unit: "积分" },
            schema: "convax.plugin-service-status/1",
            state: "connected",
            usage: {
              availability: "available",
              consumed: 7,
              period: "last up to 20 settled consumption records",
              unit: "积分",
            },
          },
        },
      })
      expect(requestCount).toBe(3)
      const stored = JSON.parse(await readFile(sessionPath, "utf8")) as Record<string, unknown>
      expect(stored).toMatchObject({
        cookies: [{
          domain: "",
          name: "sessionid_pippitcn_web",
          path: "/",
          secure: true,
          value: privateCookie,
        }],
        schema: "convax.xiaoyunque-web-session/2",
      })
      expect(stored).not.toHaveProperty("accessKeySha256")
      expect((await stat(sessionPath)).mode & 0o777).toBe(0o600)
      expect(JSON.stringify(harness.messages)).not.toContain(privateCookie)

      const signedOut = await harness.request("tools/call", { name: "service.sign_out", arguments: {} })
      expect(signedOut).toMatchObject({
        result: {
          content: [{
            type: "text",
            text: "Local XiaoYunque browser authorization cleared.",
          }],
          structuredContent: {
            account: { availability: "unavailable" },
            credential: { configured: false, verification: "unverified" },
            credits: { availability: "unavailable" },
            schema: "convax.plugin-service-status/1",
            state: "disconnected",
            usage: { availability: "unavailable" },
          },
        },
      })
      const disconnected = await harness.request("tools/call", { name: "service.status", arguments: {} })
      expect(disconnected).toMatchObject({
        result: { structuredContent: { credential: { configured: false }, state: "disconnected" } },
      })
      expect(requestCount).toBe(3)
      await expect(readFile(sessionPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" })
    } finally {
      const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()))
      child.kill("SIGTERM")
      await exited
      api.stop(true)
    }
    expect(await harness.stderr).not.toContain(privateCookie)
  })

  test("returns a safe input error for a last frame without a first frame", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "xiaoyunque-mcp-last-frame-only-"))
    directories.push(directory)
    const configRoot = path.join(directory, "config")
    const stateDirectory = path.join(configRoot, "convax", "xiaoyunque")
    const outputDirectory = path.join(directory, "output")
    const lastFrame = path.join(directory, "private-last-frame.png")
    await Promise.all([
      mkdir(stateDirectory, { recursive: true }),
      mkdir(outputDirectory),
      writeFile(lastFrame, png),
    ])
    const cookieValue = "last-frame-test-cookie"
    await writeWebSession(configRoot, cookieValue)
    let requestCount = 0
    const api = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () => {
        requestCount += 1
        return new Response("unexpected", { status: 500 })
      },
    })
    const child = spawn(process.execPath, [path.join(import.meta.dir, "..", "src", "index.ts")], {
      cwd: path.join(import.meta.dir, ".."),
      env: {
        HOME: os.homedir(),
        PATH: process.env.PATH,
        XDG_CONFIG_HOME: configRoot,
        XYQ_BASE_URL: `http://127.0.0.1:${api.port}`,
        XYQ_POLL_INTERVAL_MS: "1",
      },
      stdio: ["pipe", "pipe", "pipe"],
    })
    const harness = new JsonRpcHarness(child)
    try {
      await harness.request("initialize", {
        capabilities: {},
        clientInfo: { name: "test", version: "1" },
        protocolVersion: "2025-03-26",
      })
      const generated = await harness.request("tools/call", {
        name: "video.seedance_2.0_mini_lite",
        arguments: {
          schema: "convax.generation-call/1",
          operation_id: "last-frame-only-operation",
          prompt: "Animate this image",
          output: "video",
          output_directory: outputDirectory,
          references: [{
            kind: "file",
            mime_type: "image/png",
            name: "private-last-frame.png",
            node_id: "ordinary-canvas-image-node",
            path: lastFrame,
            role: "last_frame",
          }],
        },
      })

      expect(generated).toMatchObject({
        result: {
          content: [{ type: "text", text: "A video last frame requires exactly one first frame." }],
          isError: true,
        },
      })
      expect(requestCount).toBe(0)
      const responses = JSON.stringify(harness.messages)
      expect(responses).not.toContain(cookieValue)
      expect(responses).not.toContain(lastFrame)
    } finally {
      const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()))
      child.kill("SIGTERM")
      await exited
      api.stop(true)
    }
    const stderr = await harness.stderr
    expect(stderr).toContain("[xiaoyunque] generation failed")
    expect(stderr).not.toContain(cookieValue)
    expect(stderr).not.toContain(lastFrame)
  })

  test("handshakes, lists every model tool, and generates an image through the real stdio process", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "xiaoyunque-mcp-"))
    directories.push(directory)
    const configRoot = path.join(directory, "config")
    const stateDirectory = path.join(configRoot, "convax", "xiaoyunque")
    const outputDirectory = path.join(directory, "output")
    await Promise.all([mkdir(stateDirectory, { recursive: true }), mkdir(outputDirectory)])
    const cookieValue = "black-box-web-cookie"
    await writeWebSession(configRoot, cookieValue)
    let submitCount = 0
    let task: Awaited<ReturnType<typeof submittedTask>> | undefined
    const api = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: async (request) => {
        const url = new URL(request.url)
        if (url.pathname.startsWith("/api/")) {
          expect(request.headers.get("cookie")).toBe(`sessionid_pippitcn_web=${cookieValue}`)
          expect(request.headers.has("authorization")).toBeFalse()
        }
        const accountPreflight = await accountPreflightResponse(request)
        if (accountPreflight) return accountPreflight
        if (url.pathname === "/api/biz/v1/agent/submit_run") {
          submitCount += 1
          task = await submittedTask(request)
          return Response.json({ ret: 0, data: { accepted: true } })
        }
        if (url.pathname === "/api/biz/v1/agent/get_thread") {
          if (!task) return new Response("submit required", { status: 409 })
          return Response.json({
            ret: 0,
            data: {
              thread: {
                thread_id: task.threadId,
                run_list: [{
                  run_id: task.runId,
                  thread_id: task.threadId,
                  state: 3,
                  entry_list: [{
                    type: 2,
                    artifact: {
                      content: [{
                        sub_type: "biz/x_data_image",
                        data: JSON.stringify({ image: { url: `${url.origin}/artifact.png` } }),
                      }],
                    },
                  }],
                }],
              },
            },
          })
        }
        if (url.pathname === "/artifact.png") return new Response(png, { headers: { "Content-Type": "image/png" } })
        return new Response("not found", { status: 404 })
      },
    })
    const child = spawn(process.execPath, [path.join(import.meta.dir, "..", "src", "index.ts")], {
      cwd: path.join(import.meta.dir, ".."),
      env: {
        HOME: os.homedir(),
        PATH: process.env.PATH,
        XDG_CONFIG_HOME: configRoot,
        XYQ_BASE_URL: `http://127.0.0.1:${api.port}`,
        XYQ_POLL_INTERVAL_MS: "1",
      },
      stdio: ["pipe", "pipe", "pipe"],
    })
    const harness = new JsonRpcHarness(child)
    try {
      const initialized = await harness.request("initialize", {
        capabilities: {},
        clientInfo: { name: "test", version: "1" },
        protocolVersion: "2025-03-26",
      })
      expect(initialized).toMatchObject({ result: { protocolVersion: "2025-03-26" } })
      harness.notify("notifications/initialized", {})
      const listed = await harness.request("tools/list", {})
      expect((listed.result as { tools: Array<{ name: string }> }).tools.map((tool) => tool.name))
        .toEqual([
          "image.seedream_5.0_pro",
          "image.seedream_5.0",
          "image.seedream_4.3",
          "image.seedream_4.5",
          "image.seedream_4.1",
          "image.seedream_4",
          "image.nano_banana_pro_1",
          "image.gpt_image_2",
          "video.seedance_2.0_mini_lite",
          "video.seedance_2.0_mini",
          "video.seedance2.0_fast_vision",
          "video.seedance2.0_vision",
          "video.seedance2.0_fast_direct",
          "video.seedance2.0_direct",
          "video.seedance1.5_direct",
          "video.seedance_1.0_fast",
          "service.status",
          "service.authorize",
          "service.reauthorize",
          "service.authorization.cancel",
          "service.authorization.complete",
          "service.sign_out",
        ])
      const generated = await harness.request("tools/call", {
        name: "image.seedream_4.5",
        arguments: {
          schema: "convax.generation-call/1",
          operation_id: "black-box-operation",
          prompt: "Create a monochrome paper bird",
          output: "image",
          output_directory: outputDirectory,
          references: [],
        },
      })
      expect(generated).toMatchObject({
        result: {
          content: [{ type: "text" }],
          structuredContent: { artifacts: [{ mimeType: "image/png" }] },
        },
      })
      const artifact = ((generated.result as { structuredContent: { artifacts: Array<{ path: string }> } })
        .structuredContent.artifacts[0])!
      expect(new Uint8Array(await readFile(path.join(outputDirectory, artifact.path)))).toEqual(png)
      expect(submitCount).toBe(1)
      expect(harness.messages.every((message) => message && typeof message === "object")).toBeTrue()
    } finally {
      const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()))
      child.kill("SIGTERM")
      await exited
      api.stop(true)
    }
    expect(await harness.stderr).not.toContain(cookieValue)
  })

  test("generates a video through the shared get-thread endpoint in the real stdio process", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "xiaoyunque-mcp-video-"))
    directories.push(directory)
    const configRoot = path.join(directory, "config")
    const outputDirectory = path.join(directory, "output")
    await mkdir(outputDirectory, { recursive: true })
    const cookieValue = "black-box-video-web-cookie"
    await writeWebSession(configRoot, cookieValue)
    let task: Awaited<ReturnType<typeof submittedTask>> | undefined
    let queryCount = 0
    const api = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: async (request) => {
        const url = new URL(request.url)
        if (url.pathname.startsWith("/api/")) {
          expect(request.headers.get("cookie")).toBe(`sessionid_pippitcn_web=${cookieValue}`)
          expect(request.headers.has("authorization")).toBeFalse()
        }
        const accountPreflight = await accountPreflightResponse(request)
        if (accountPreflight) return accountPreflight
        if (url.pathname === "/api/biz/v1/agent/submit_run") {
          task = await submittedTask(request)
          return Response.json({ ret: 0, data: { accepted: true } })
        }
        if (url.pathname === "/api/biz/v1/agent/get_thread") {
          if (!task) return new Response("submit required", { status: 409 })
          expect(await request.json()).toEqual({
            run_id: task.runId,
            scopes: ["run_list.entry_list"],
            thread_id: task.threadId,
          })
          queryCount += 1
          return Response.json({
            ret: 0,
            data: {
              thread: {
                thread_id: task.threadId,
                run_list: [{
                  entry_list: queryCount === 1
                    ? []
                    : [{
                        type: 2,
                        artifact: {
                          content: [{
                            sub_type: "biz/x_data_video",
                            data: JSON.stringify({ video: { url: `${url.origin}/artifact.mp4` } }),
                          }],
                        },
                      }],
                  run_id: task.runId,
                  state: queryCount === 1 ? "2" : 3,
                  thread_id: task.threadId,
                }],
              },
            },
          })
        }
        if (url.pathname === "/artifact.mp4") {
          return new Response(mp4, { headers: { "Content-Type": "video/mp4" } })
        }
        return new Response("not found", { status: 404 })
      },
    })
    const child = spawn(process.execPath, [path.join(import.meta.dir, "..", "src", "index.ts")], {
      cwd: path.join(import.meta.dir, ".."),
      env: {
        HOME: os.homedir(),
        PATH: process.env.PATH,
        XDG_CONFIG_HOME: configRoot,
        XYQ_BASE_URL: `http://127.0.0.1:${api.port}`,
        XYQ_POLL_INTERVAL_MS: "1",
      },
      stdio: ["pipe", "pipe", "pipe"],
    })
    const harness = new JsonRpcHarness(child)
    try {
      await harness.request("initialize", {
        capabilities: {},
        clientInfo: { name: "test", version: "1" },
        protocolVersion: "2025-03-26",
      })
      const generated = await harness.request("tools/call", {
        name: "video.seedance_2.0_mini_lite",
        arguments: {
          schema: "convax.generation-call/1",
          operation_id: "black-box-video-operation",
          prompt: "Animate a paper bird",
          output: "video",
          output_directory: outputDirectory,
          references: [],
        },
      })
      expect(generated).toMatchObject({
        result: {
          content: [{ type: "text" }],
          structuredContent: { artifacts: [{ mimeType: "video/mp4" }] },
        },
      })
      const artifact = ((generated.result as { structuredContent: { artifacts: Array<{ path: string }> } })
        .structuredContent.artifacts[0])!
      expect(new Uint8Array(await readFile(path.join(outputDirectory, artifact.path)))).toEqual(mp4)
      expect(queryCount).toBe(2)
      expect(JSON.stringify(harness.messages)).not.toContain(cookieValue)
    } finally {
      const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()))
      child.kill("SIGTERM")
      await exited
      api.stop(true)
    }
    expect(await harness.stderr).not.toContain(cookieValue)
  })

  test("aborts an inflight generation and exits when the MCP client closes stdin", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "xiaoyunque-mcp-eof-"))
    directories.push(directory)
    const configRoot = path.join(directory, "config")
    const stateDirectory = path.join(configRoot, "convax", "xiaoyunque")
    const outputDirectory = path.join(directory, "output")
    await Promise.all([mkdir(stateDirectory, { recursive: true }), mkdir(outputDirectory)])
    const cookieValue = "eof-test-web-cookie"
    await writeWebSession(configRoot, cookieValue)
    let signalPollStarted!: () => void
    const pollStarted = new Promise<void>((resolve) => { signalPollStarted = resolve })
    let task: Awaited<ReturnType<typeof submittedTask>> | undefined
    const api = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: async (request) => {
        const url = new URL(request.url)
        if (url.pathname.startsWith("/api/")) {
          expect(request.headers.get("cookie")).toBe(`sessionid_pippitcn_web=${cookieValue}`)
          expect(request.headers.has("authorization")).toBeFalse()
        }
        const accountPreflight = await accountPreflightResponse(request)
        if (accountPreflight) return accountPreflight
        if (url.pathname === "/api/biz/v1/agent/submit_run") {
          task = await submittedTask(request)
          return Response.json({ ret: 0, data: { accepted: true } })
        }
        if (url.pathname === "/api/biz/v1/agent/get_thread") {
          if (!task) return new Response("submit required", { status: 409 })
          signalPollStarted()
          return Response.json({
            ret: 0,
            data: {
              thread: {
                thread_id: task.threadId,
                run_list: [{
                  run_id: task.runId,
                  thread_id: task.threadId,
                  state: 1,
                  entry_list: [],
                }],
              },
            },
          })
        }
        return new Response("not found", { status: 404 })
      },
    })
    const child = spawn(process.execPath, [path.join(import.meta.dir, "..", "src", "index.ts")], {
      cwd: path.join(import.meta.dir, ".."),
      env: {
        HOME: os.homedir(),
        PATH: process.env.PATH,
        XDG_CONFIG_HOME: configRoot,
        XYQ_BASE_URL: `http://127.0.0.1:${api.port}`,
        XYQ_POLL_INTERVAL_MS: "60000",
      },
      stdio: ["pipe", "pipe", "pipe"],
    })
    const harness = new JsonRpcHarness(child)
    const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
      child.once("exit", (code, signal) => resolve({ code, signal }))
    })
    try {
      await harness.request("initialize", {
        capabilities: {},
        clientInfo: { name: "test", version: "1" },
        protocolVersion: "2025-03-26",
      })
      void harness.request("tools/call", {
        name: "image.seedream_4.5",
        arguments: {
          schema: "convax.generation-call/1",
          operation_id: "stdin-eof-operation",
          prompt: "Keep polling until the client goes away",
          output: "image",
          output_directory: outputDirectory,
          references: [],
        },
      })
      await withTimeout(pollStarted, 2_000, "generation did not begin polling")

      child.stdin.end()
      const result = await withTimeout(exited, 2_000, "MCP process did not exit after stdin EOF")
      expect(result).toEqual({ code: 0, signal: null })
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGTERM")
        await withTimeout(exited, 2_000, "MCP process did not stop during test cleanup")
      }
      api.stop(true)
    }
    const stderr = await harness.stderr
    expect(stderr).not.toContain(cookieValue)
    expect(stderr).toContain("[xiaoyunque] generation cancelled")
  })

  test("drains an inflight handler and exits cleanly on SIGTERM", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "xiaoyunque-mcp-sigterm-"))
    directories.push(directory)
    const configRoot = path.join(directory, "config")
    const stateDirectory = path.join(configRoot, "convax", "xiaoyunque")
    const outputDirectory = path.join(directory, "output")
    await Promise.all([mkdir(stateDirectory, { recursive: true }), mkdir(outputDirectory)])
    const cookieValue = "sigterm-test-web-cookie"
    await writeWebSession(configRoot, cookieValue)
    let signalPollStarted!: () => void
    const pollStarted = new Promise<void>((resolve) => { signalPollStarted = resolve })
    let task: Awaited<ReturnType<typeof submittedTask>> | undefined
    const api = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: async (request) => {
        const url = new URL(request.url)
        if (url.pathname.startsWith("/api/")) {
          expect(request.headers.get("cookie")).toBe(`sessionid_pippitcn_web=${cookieValue}`)
          expect(request.headers.has("authorization")).toBeFalse()
        }
        const accountPreflight = await accountPreflightResponse(request)
        if (accountPreflight) return accountPreflight
        if (url.pathname === "/api/biz/v1/agent/submit_run") {
          task = await submittedTask(request)
          return Response.json({ ret: 0, data: { accepted: true } })
        }
        if (url.pathname === "/api/biz/v1/agent/get_thread") {
          if (!task) return new Response("submit required", { status: 409 })
          signalPollStarted()
          return Response.json({
            ret: 0,
            data: {
              thread: {
                thread_id: task.threadId,
                run_list: [{
                  run_id: task.runId,
                  thread_id: task.threadId,
                  state: 1,
                  entry_list: [],
                }],
              },
            },
          })
        }
        return new Response("not found", { status: 404 })
      },
    })
    const child = spawn(process.execPath, [path.join(import.meta.dir, "..", "src", "index.ts")], {
      cwd: path.join(import.meta.dir, ".."),
      env: {
        HOME: os.homedir(),
        PATH: process.env.PATH,
        XDG_CONFIG_HOME: configRoot,
        XYQ_BASE_URL: `http://127.0.0.1:${api.port}`,
        XYQ_POLL_INTERVAL_MS: "60000",
      },
      stdio: ["pipe", "pipe", "pipe"],
    })
    const harness = new JsonRpcHarness(child)
    const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
      child.once("exit", (code, signal) => resolve({ code, signal }))
    })
    try {
      await harness.request("initialize", {
        capabilities: {},
        clientInfo: { name: "test", version: "1" },
        protocolVersion: "2025-03-26",
      })
      void harness.request("tools/call", {
        name: "image.seedream_4.5",
        arguments: {
          schema: "convax.generation-call/1",
          operation_id: "sigterm-operation",
          prompt: "Keep polling until the server receives SIGTERM",
          output: "image",
          output_directory: outputDirectory,
          references: [],
        },
      })
      await withTimeout(pollStarted, 2_000, "generation did not begin polling")

      child.kill("SIGTERM")
      expect(await withTimeout(exited, 2_000, "MCP process did not exit after SIGTERM"))
        .toEqual({ code: 0, signal: null })
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL")
        await withTimeout(exited, 2_000, "MCP process did not stop during test cleanup")
      }
      api.stop(true)
    }
    const stderr = await harness.stderr
    expect(stderr).not.toContain(cookieValue)
    expect(stderr).toContain("[xiaoyunque] generation cancelled")
    expect(stderr).not.toContain("shutdown grace period expired")
  })
})
