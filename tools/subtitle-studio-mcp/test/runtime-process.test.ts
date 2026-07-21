import { describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import { createRuntimeCommandRunner } from "../src/runtime/process"

describe("companion runtime process runner", () => {
  test("passes hostile-looking values as argv without shell interpolation", async () => {
    const marker = path.join(os.tmpdir(), `subtitle-runner-marker-${crypto.randomUUID()}`)
    const hostile = `$(touch ${marker})`
    const runner = createRuntimeCommandRunner()
    const result = await runner(
      process.execPath,
      ["-e", "process.stdout.write(process.argv.at(-1) ?? '')", hostile],
      new AbortController().signal,
    )
    expect(result.stdout).toBe(hostile)
    await expect(fs.lstat(marker)).rejects.toMatchObject({ code: "ENOENT" })
  })

  test("bounds child output", async () => {
    const runner = createRuntimeCommandRunner({ maximumOutputBytes: 32 })
    await expect(
      runner(process.execPath, ["-e", "process.stdout.write('x'.repeat(128))"], new AbortController().signal),
    ).rejects.toThrow("too much output")
  })

  test("cancels a running process and preserves the abort reason", async () => {
    const controller = new AbortController()
    const runner = createRuntimeCommandRunner({ terminationGraceMs: 20 })
    const running = runner(
      process.execPath,
      ["-e", "setInterval(() => undefined, 1000)"],
      controller.signal,
    )
    await Bun.sleep(20)
    controller.abort(new DOMException("Stopped by test", "AbortError"))
    await expect(running).rejects.toThrow("Stopped by test")
  })
})
