#!/usr/bin/env convax-bun

import path from "node:path"
import { XiaoYunqueAuthorizationState } from "./authorization-state.ts"
import { GenerationEngine } from "./generator.ts"
import { McpServer } from "./mcp-server.ts"
import { OperationStore } from "./operation-store.ts"
import { XiaoYunquePluginService } from "./plugin-service.ts"
import { XiaoYunqueServiceMetadataClient } from "./service-metadata.ts"
import { defaultStateDirectory } from "./state-directory.ts"
import { FileWebSessionStore } from "./web-session-store.ts"
import { XiaoYunqueApi } from "./xiaoyunque-api.ts"

const defaultBaseUrl = "https://xyq.jianying.com"
const shutdownGracePeriodMs = 5_000
const queryRequestTimeoutMs = 30_000

function positiveEnvironmentNumber(name: string, fallback: number, allowOverride: boolean) {
  if (!allowOverride) return fallback
  const value = Number(Bun.env[name])
  return Number.isFinite(value) && value > 0 ? value : fallback
}

export function createServer(environment: Record<string, string | undefined> = Bun.env) {
  const { baseUrl, isLoopbackTest, stateDirectory } = runtimeConfiguration(environment)
  const authorizationState = new XiaoYunqueAuthorizationState(
    new FileWebSessionStore(path.join(stateDirectory, "web-session.json")),
  )
  const api = new XiaoYunqueApi(baseUrl.toString(), fetch, {
    queryRequestTimeoutMs: positiveEnvironmentNumber(
      "XYQ_QUERY_REQUEST_TIMEOUT_MS",
      queryRequestTimeoutMs,
      isLoopbackTest,
    ),
  })
  const engine = new GenerationEngine({
    api,
    authorizer: authorizationState,
    operationStore: new OperationStore(path.join(stateDirectory, "operations.json")),
    pollIntervalMs: positiveEnvironmentNumber("XYQ_POLL_INTERVAL_MS", 10_000, isLoopbackTest),
  })
  return new McpServer(engine, new XiaoYunquePluginService(
    authorizationState,
    new XiaoYunqueServiceMetadataClient({
      ...(isLoopbackTest ? { baseUrl: baseUrl.toString() } : {}),
    }),
  ))
}

function runtimeConfiguration(environment: Record<string, string | undefined>) {
  const configuredBase = environment.XYQ_BASE_URL?.trim() || defaultBaseUrl
  const baseUrl = new URL(configuredBase)
  const hasExactBaseShape =
    !baseUrl.username &&
    !baseUrl.password &&
    !baseUrl.search &&
    !baseUrl.hash &&
    baseUrl.pathname === "/"
  const isOfficial =
    hasExactBaseShape &&
    baseUrl.protocol === "https:" &&
    baseUrl.hostname === "xyq.jianying.com" &&
    !baseUrl.port
  const isLoopbackTest =
    hasExactBaseShape &&
    baseUrl.protocol === "http:" &&
    baseUrl.hostname === "127.0.0.1"
  if (!isOfficial && !isLoopbackTest) {
    throw new Error("XiaoYunque API base must be the official HTTPS endpoint")
  }
  return { baseUrl, isLoopbackTest, stateDirectory: defaultStateDirectory(environment) }
}

async function runMcpServer() {
  const server = createServer()
  let shutdown: Promise<boolean> | undefined
  const stop = () => {
    shutdown ??= server.shutdown(shutdownGracePeriodMs)
    void shutdown.then((drained) => {
      if (!drained) console.error("[xiaoyunque] shutdown grace period expired")
      process.exit(0)
    }, () => process.exit(1))
  }
  process.once("SIGINT", stop)
  process.once("SIGTERM", stop)
  try {
    await server.run()
  } finally {
    try {
      await (shutdown ?? server.shutdown(shutdownGracePeriodMs))
    } finally {
      process.removeListener("SIGINT", stop)
      process.removeListener("SIGTERM", stop)
    }
  }
}

if (import.meta.main) {
  const args = process.argv.slice(2)
  if (args.length === 0) {
    await runMcpServer()
  } else {
    throw new Error("Usage: convax-xiaoyunque-mcp")
  }
}
