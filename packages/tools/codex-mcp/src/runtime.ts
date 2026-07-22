import { CodexAppServerClient } from "./app-server-client.ts"
import { resolveCodexExecutable, type CodexLocatorOptions } from "./codex-locator.ts"

export interface CodexRuntimeOptions extends CodexLocatorOptions {
  createClient?: (executable: string) => CodexAppServerClient
}

export class CodexRuntime {
  readonly #createClient: NonNullable<CodexRuntimeOptions["createClient"]>
  readonly #locatorOptions: CodexLocatorOptions
  #client: CodexAppServerClient | undefined
  #starting: Promise<CodexAppServerClient> | undefined

  constructor(options: CodexRuntimeOptions = {}) {
    const environment = options.environment ?? process.env
    this.#createClient = options.createClient ?? ((executable) => new CodexAppServerClient(executable, {
      environment: { ...environment },
    }))
    this.#locatorOptions = {
      environment,
      ...(options.platform === undefined ? {} : { platform: options.platform }),
      ...(options.probeVersion === undefined ? {} : { probeVersion: options.probeVersion }),
    }
  }

  async client() {
    if (this.#client) return this.#client
    return await (this.#starting ??= this.#start())
  }

  async #start() {
    let client: CodexAppServerClient | undefined
    try {
      client = this.#createClient(await resolveCodexExecutable(this.#locatorOptions))
      await client.start()
      this.#client = client
      return client
    } catch (error) {
      client?.close()
      throw error
    } finally {
      this.#starting = undefined
    }
  }

  async rebind() {
    this.#client?.close()
    this.#client = undefined
    return await this.client()
  }

  close() {
    this.#client?.close()
    this.#client = undefined
  }
}
