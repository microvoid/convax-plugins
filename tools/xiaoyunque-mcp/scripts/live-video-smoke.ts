#!/usr/bin/env bun

import { spawn } from "node:child_process"
import { access, mkdtemp, readFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { createInterface } from "node:readline"
import {
  formatSafeGenerationFailure,
  formatSafeGenerationOperation,
  parseSafeGenerationFailureLine,
  type SafeGenerationDiagnosticCode,
} from "./live-video-smoke-diagnostics.ts"

if (process.env.CONVAX_LIVE_XIAOYUNQUE_VIDEO !== "1") {
  throw new Error(
    "Refusing to run a billable XiaoYunque live video smoke; set CONVAX_LIVE_XIAOYUNQUE_VIDEO=1 explicitly",
  )
}

const executable = path.join(import.meta.dir, "..", "dist", "convax-xiaoyunque-mcp")
await access(executable).catch(() => {
  throw new Error("Build the sidecar first with `bun run build`")
})

const outputDirectory = await mkdtemp(path.join(os.tmpdir(), "convax-xiaoyunque-live-video-"))
const prompt = process.argv.slice(2).join(" ").trim()
  || "一只彩纸拼贴的小云雀轻轻扇动翅膀，固定镜头，米白背景，柔和自然光"
const toolName = "video.seedance_2.0_mini_lite"
const operationId = `live-video-${crypto.randomUUID()}`
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
const pending = new Map<number, {
  reject: (error: Error) => void
  resolve: (message: Record<string, unknown>) => void
}>()
const lines = createInterface({ input: child.stdout })
lines.on("line", (line) => {
  try {
    const message = JSON.parse(line) as Record<string, unknown>
    if (typeof message.id === "number") pending.get(message.id)?.resolve(message)
  } catch {
    // MCP stdout is machine-only. Never echo malformed output because it may
    // contain an upstream diagnostic that is not safe for a live-smoke log.
  }
})
let observedGenerationFailureCategory: SafeGenerationDiagnosticCode | undefined
let resolveGenerationFailureCategory: ((category: SafeGenerationDiagnosticCode) => void) | undefined
const generationFailureCategoryObserved = new Promise<SafeGenerationDiagnosticCode>((resolve) => {
  resolveGenerationFailureCategory = resolve
})
const stderrLines = createInterface({ crlfDelay: Infinity, input: child.stderr })
stderrLines.on("line", (line) => {
  const category = parseSafeGenerationFailureLine(line)
  if (!category || observedGenerationFailureCategory) return
  observedGenerationFailureCategory = category
  resolveGenerationFailureCategory?.(category)
})
const childExit = new Promise<void>((resolve) => child.once("exit", () => {
  for (const request of pending.values()) {
    request.reject(new Error("XiaoYunque sidecar exited before the live video smoke completed"))
  }
  resolve()
}))

function progress(stage: string) {
  process.stderr.write(`${JSON.stringify({ stage, status: "running" })}\n`)
}

async function generationFailureCategory(): Promise<SafeGenerationDiagnosticCode> {
  if (observedGenerationFailureCategory) return observedGenerationFailureCategory
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      generationFailureCategoryObserved,
      new Promise<SafeGenerationDiagnosticCode>((resolve) => {
        timer = setTimeout(() => resolve("unclassified-failure"), 250)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

async function reportGenerationFailure(): Promise<never> {
  const category = await generationFailureCategory()
  process.stderr.write(`${formatSafeGenerationFailure(category)}\n`)
  throw new Error(`XiaoYunque live video generation failed (${category})`)
}

function request(method: string, params: unknown) {
  const id = nextId++
  const result = new Promise<Record<string, unknown>>((resolve, reject) => {
    pending.set(id, { reject, resolve })
  })
  child.stdin.write(`${JSON.stringify({ id, jsonrpc: "2.0", method, params })}\n`)
  return result.finally(() => pending.delete(id))
}

function notify(method: string, params: unknown) {
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`)
}

try {
  progress("mcp.initialize")
  const initialized = await request("initialize", {
    capabilities: {},
    clientInfo: { name: "convax-xiaoyunque-live-video-smoke", version: "0.3.0" },
    protocolVersion: "2025-03-26",
  })
  if ((initialized.result as Record<string, unknown> | undefined)?.protocolVersion !== "2025-03-26") {
    throw new Error("Sidecar did not negotiate the expected MCP protocol")
  }
  notify("notifications/initialized", {})

  progress("tool.verify")
  const listed = await request("tools/list", {})
  const names = ((listed.result as { tools?: Array<{ name?: string }> } | undefined)?.tools ?? [])
    .map((tool) => tool.name)
  if (!names.includes(toolName)) {
    throw new Error("Sidecar did not expose the verified Seedance 2.0 Mini Lite generation tool")
  }

  process.stderr.write(`${formatSafeGenerationOperation(operationId)}\n`)
  const generated = await request("tools/call", {
    name: toolName,
    arguments: {
      schema: "convax.generation-call/1",
      operation_id: operationId,
      prompt,
      output: "video",
      output_directory: outputDirectory,
      references: [],
    },
  }).catch(() => reportGenerationFailure())
  const result = generated.result as {
    isError?: boolean
    structuredContent?: { artifacts?: Array<{ mimeType?: string; path?: string }> }
  } | undefined
  if (!result || result.isError) await reportGenerationFailure()
  const artifacts = result?.structuredContent?.artifacts ?? []
  if (artifacts.length !== 1) {
    throw new Error(`XiaoYunque live video generation returned ${artifacts.length} artifacts instead of exactly one`)
  }
  const artifact = artifacts[0]
  if (!artifact?.path || !artifact.mimeType?.startsWith("video/")) {
    throw new Error("XiaoYunque live video generation returned no video artifact")
  }

  progress("artifact.verify")
  const artifactPath = path.join(outputDirectory, artifact.path)
  const bytes = await readFile(artifactPath)
  if (bytes.byteLength < 12) throw new Error("XiaoYunque live video artifact is empty")
  process.stdout.write(`${JSON.stringify({
    artifactCount: artifacts.length,
    artifactPath,
    bytes: bytes.byteLength,
    durationSeconds: 5,
    mimeType: artifact.mimeType,
    model: "Seedance_2.0_mini_lite",
    stage: "complete",
  })}\n`)
} finally {
  if (child.exitCode === null) child.kill("SIGTERM")
  await childExit
}
