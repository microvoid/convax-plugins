import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process"

const maximumMessageBytes = 64 * 1024 * 1024
const startupTimeoutMs = 10_000
const requestTimeoutMs = 10_000

interface PendingRequest {
  reject(error: Error): void
  resolve(value: unknown): void
  timeout?: ReturnType<typeof setTimeout>
}

export interface AppServerMessage {
  error?: unknown
  id?: number | string
  method?: string
  params?: unknown
  result?: unknown
}

export interface AppServerRequestContext {
  id: number | string
  method: string
  params: unknown
}

export type AppServerRequestHandler = (
  request: AppServerRequestContext,
) => Promise<{ handled: true; result: unknown } | { handled: false }> | { handled: true; result: unknown } | { handled: false }

export interface AppServerClientOptions {
  environment?: NodeJS.ProcessEnv
  spawnProcess?: (executable: string, args: string[], environment: NodeJS.ProcessEnv) => ChildProcessWithoutNullStreams
}

function publicProtocolError(value: unknown) {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const message = (value as Record<string, unknown>).message
    if (typeof message === "string" && message.length > 0 && message.length <= 1_000) {
      return new Error(message)
    }
  }
  return new Error("Local Codex app-server request failed")
}

function abortError(reason?: unknown) {
  const error = reason instanceof Error ? reason : new Error("Local Codex request was cancelled")
  error.name = "AbortError"
  return error
}

export class CodexAppServerClient {
  readonly #environment: NodeJS.ProcessEnv
  readonly #executable: string
  readonly #listeners = new Set<(message: AppServerMessage) => void>()
  readonly #pending = new Map<number, PendingRequest>()
  readonly #requestHandlers = new Set<AppServerRequestHandler>()
  readonly #spawnProcess: NonNullable<AppServerClientOptions["spawnProcess"]>
  #buffer = ""
  #child: ChildProcessWithoutNullStreams | undefined
  #closed = false
  #nextId = 1
  #starting: Promise<void> | undefined

  constructor(executable: string, options: AppServerClientOptions = {}) {
    this.#executable = executable
    this.#environment = options.environment ?? process.env
    this.#spawnProcess = options.spawnProcess ?? ((command, args, environment) => spawn(command, args, {
      env: environment,
      stdio: ["pipe", "pipe", "pipe"],
    }))
  }

  onMessage(listener: (message: AppServerMessage) => void) {
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }

  onRequest(handler: AppServerRequestHandler) {
    this.#requestHandlers.add(handler)
    return () => this.#requestHandlers.delete(handler)
  }

  async start() {
    if (this.#closed) throw new Error("Local Codex app-server client is closed")
    return await (this.#starting ??= this.#start())
  }

  async #start() {
    const child = this.#spawnProcess(
      this.#executable,
      ["app-server", "--listen", "stdio://"],
      { ...this.#environment },
    )
    this.#child = child
    child.stdout.setEncoding("utf8")
    child.stderr.on("data", () => undefined)
    child.stdout.on("data", (chunk: string) => this.#receive(chunk))
    child.once("error", () => this.#fail(new Error("Local Codex app-server could not start")))
    child.once("exit", () => this.#fail(new Error("Local Codex app-server exited")))
    await this.#requestWithoutStart("initialize", {
      capabilities: { experimentalApi: true },
      clientInfo: {
        name: "convax-codex-service",
        title: "Convax Codex Service",
        version: "0.1.1",
      },
    }, { timeoutMs: startupTimeoutMs })
    this.#write({ method: "initialized" })
  }

  async request(
    method: string,
    params?: unknown,
    options: { signal?: AbortSignal | undefined; timeoutMs?: number | null } = {},
  ) {
    await this.start()
    return await this.#requestWithoutStart(method, params, options)
  }

  async #requestWithoutStart(
    method: string,
    params?: unknown,
    options: { signal?: AbortSignal | undefined; timeoutMs?: number | null } = {},
  ) {
    if (options.signal?.aborted) throw abortError(options.signal.reason)
    const id = this.#nextId++
    const response = new Promise<unknown>((resolve, reject) => {
      const pending: PendingRequest = { reject, resolve }
      const timeoutMs = options.timeoutMs === undefined ? requestTimeoutMs : options.timeoutMs
      if (timeoutMs !== null) {
        pending.timeout = setTimeout(() => {
          this.#pending.delete(id)
          reject(new Error("Local Codex app-server request timed out"))
        }, timeoutMs)
      }
      this.#pending.set(id, pending)
    })
    const onAbort = () => {
      const pending = this.#pending.get(id)
      if (!pending) return
      this.#pending.delete(id)
      if (pending.timeout) clearTimeout(pending.timeout)
      pending.reject(abortError(options.signal?.reason))
    }
    options.signal?.addEventListener("abort", onAbort, { once: true })
    try {
      this.#write({ id, method, ...(params === undefined ? {} : { params }) })
      return await response
    } finally {
      options.signal?.removeEventListener("abort", onAbort)
    }
  }

  #write(value: unknown) {
    if (!this.#child || this.#closed) throw new Error("Local Codex app-server is unavailable")
    const message = `${JSON.stringify(value)}\n`
    if (Buffer.byteLength(message, "utf8") > maximumMessageBytes) {
      throw new Error("Local Codex app-server request exceeded the message size limit")
    }
    this.#child.stdin.write(message)
  }

  #receive(chunk: string) {
    this.#buffer += chunk
    if (Buffer.byteLength(this.#buffer, "utf8") > maximumMessageBytes) {
      this.#fail(new Error("Local Codex app-server response exceeded the message size limit"))
      return
    }
    while (true) {
      const newline = this.#buffer.indexOf("\n")
      if (newline < 0) return
      const line = this.#buffer.slice(0, newline).trim()
      this.#buffer = this.#buffer.slice(newline + 1)
      if (!line) continue
      let message: AppServerMessage
      try {
        message = JSON.parse(line) as AppServerMessage
      } catch {
        this.#fail(new Error("Local Codex app-server returned malformed JSON"))
        return
      }
      if (message.id !== undefined && message.method === undefined) {
        const id = typeof message.id === "number" ? message.id : Number(message.id)
        const pending = Number.isSafeInteger(id) ? this.#pending.get(id) : undefined
        if (!pending) continue
        this.#pending.delete(id)
        if (pending.timeout) clearTimeout(pending.timeout)
        if (message.error !== undefined) pending.reject(publicProtocolError(message.error))
        else pending.resolve(message.result)
      } else if (message.id !== undefined && typeof message.method === "string") {
        void this.#handleServerRequest(message.id, message.method, message.params)
      } else if (typeof message.method === "string") {
        for (const listener of this.#listeners) listener(message)
      }
    }
  }

  async #handleServerRequest(id: number | string, method: string, params: unknown) {
    try {
      for (const handler of this.#requestHandlers) {
        const response = await handler({ id, method, params })
        if (response.handled) {
          this.#write({ id, result: response.result })
          return
        }
      }
      const result = method === "item/tool/call"
        ? { contentItems: [{ text: "Tool execution is unavailable.", type: "inputText" }], success: false }
        : { decision: "decline" }
      this.#write({ id, result })
    } catch {
      this.#write({ error: { code: -32_603, message: "Local Codex client rejected the request" }, id })
    }
  }

  #fail(error: Error) {
    if (this.#closed) return
    this.#closed = true
    this.#child?.kill("SIGKILL")
    for (const pending of this.#pending.values()) {
      if (pending.timeout) clearTimeout(pending.timeout)
      pending.reject(error)
    }
    this.#pending.clear()
  }

  close() {
    this.#fail(new Error("Local Codex app-server client closed"))
  }
}
