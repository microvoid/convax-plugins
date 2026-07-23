#!/usr/bin/env bun

import { spawn } from "node:child_process"
import { access, mkdtemp, readFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { createInterface } from "node:readline"

if (process.env.CONVAX_LIVE_XIAOYUNQUE !== "1") {
  throw new Error(
    "Refusing to run a billable XiaoYunque live smoke; set CONVAX_LIVE_XIAOYUNQUE=1 explicitly",
  )
}

const executable = path.join(import.meta.dir, "..", "dist", "convax-xiaoyunque-mcp")
await access(executable).catch(() => {
  throw new Error("Build the sidecar first with `bun run build`")
})

const outputDirectory = await mkdtemp(path.join(os.tmpdir(), "convax-xiaoyunque-live-"))
const prompt = process.argv.slice(2).join(" ").trim() || "一只由彩纸拼贴而成的小云雀，米白背景，柔和自然光，正方形构图"
const child = spawn(executable, [], {
  cwd: path.join(import.meta.dir, ".."),
  env: {
    HOME: process.env.HOME,
    LANG: process.env.LANG,
    LC_ALL: process.env.LC_ALL,
    PATH: process.env.PATH,
    TMPDIR: process.env.TMPDIR,
    XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
  },
  stdio: ["pipe", "pipe", "pipe"],
})

let nextId = 1
const pending = new Map<number, (message: Record<string, unknown>) => void>()
const lines = createInterface({ input: child.stdout })
lines.on("line", (line) => {
  const message = JSON.parse(line) as Record<string, unknown>
  if (typeof message.id === "number") pending.get(message.id)?.(message)
})
child.stderr.on("data", () => undefined)

function request(method: string, params: unknown) {
  const id = nextId++
  const result = new Promise<Record<string, unknown>>((resolve) => pending.set(id, resolve))
  child.stdin.write(`${JSON.stringify({ id, jsonrpc: "2.0", method, params })}\n`)
  return result.finally(() => pending.delete(id))
}

function notify(method: string, params: unknown) {
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`)
}

try {
  const initialized = await request("initialize", {
    capabilities: {},
    clientInfo: { name: "convax-xiaoyunque-live-smoke", version: "0.3.3" },
    protocolVersion: "2025-03-26",
  })
  if ((initialized.result as Record<string, unknown> | undefined)?.protocolVersion !== "2025-03-26") {
    throw new Error("Sidecar did not negotiate the expected MCP protocol")
  }
  notify("notifications/initialized", {})
  const listed = await request("tools/list", {})
  const names = ((listed.result as { tools?: Array<{ name?: string }> } | undefined)?.tools ?? []).map((tool) => tool.name)
  if (!names.includes("image.seedream_5.0")) {
    throw new Error("Sidecar did not expose the default Seedream 5.0 generation tool")
  }
  process.stderr.write("将使用 Convax 服务页授权的小云雀网页会话执行一次计费生图。\n")
  const generated = await request("tools/call", {
    name: "image.seedream_5.0",
    arguments: {
      schema: "convax.generation-call/1",
      operation_id: `live-image-${crypto.randomUUID()}`,
      prompt,
      output: "image",
      output_directory: outputDirectory,
      references: [],
    },
  })
  const result = generated.result as {
    isError?: boolean
    structuredContent?: { artifacts?: Array<{ mimeType?: string; path?: string }> }
  } | undefined
  if (!result || result.isError) throw new Error("XiaoYunque live image generation failed")
  const artifacts = result.structuredContent?.artifacts ?? []
  if (artifacts.length !== 1) {
    throw new Error(`XiaoYunque live image generation returned ${artifacts.length} artifacts instead of exactly one`)
  }
  const artifact = artifacts[0]
  if (!artifact?.path || !artifact.mimeType?.startsWith("image/")) {
    throw new Error("XiaoYunque live image generation returned no image artifact")
  }
  const artifactPath = path.join(outputDirectory, artifact.path)
  const bytes = await readFile(artifactPath)
  if (bytes.byteLength < 8) throw new Error("XiaoYunque live image artifact is empty")
  process.stdout.write(`${JSON.stringify({
    artifactCount: artifacts.length,
    artifactPath,
    bytes: bytes.byteLength,
    mimeType: artifact.mimeType,
  })}\n`)
} finally {
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()))
  child.kill("SIGTERM")
  await exited
}
