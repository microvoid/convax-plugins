import { afterEach, describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { resolveCodexExecutable } from "../src/codex-locator.ts"

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => fs.rm(directory, { force: true, recursive: true })))
})

describe("local Codex locator", () => {
  test("fails closed when no compatible executable is present", async () => {
    await expect(resolveCodexExecutable({
      environment: { HOME: "/nonexistent", PATH: "/nonexistent" },
      platform: "linux",
      probeVersion: async () => false,
    })).rejects.toThrow("compatible local Codex")
  })

  test("accepts a validated executable from an absolute host PATH", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "convax-codex-locator-test-"))
    temporaryDirectories.push(directory)
    const executable = path.join(directory, "codex")
    await fs.writeFile(executable, "test")
    await fs.chmod(executable, 0o700)
    const canonicalExecutable = await fs.realpath(executable)
    const result = await resolveCodexExecutable({
      environment: { HOME: "/nonexistent", PATH: directory },
      platform: "linux",
      probeVersion: async (candidate) => candidate === canonicalExecutable,
    })
    expect(result).toBe(canonicalExecutable)
  })
})
