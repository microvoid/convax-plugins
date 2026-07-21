import { afterEach, describe, expect, test } from "bun:test"
import {
  chmod,
  lstat,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import {
  FileWebSessionStore,
  webSessionSchema,
  type StoredWebSession,
} from "../src/web-session-store.ts"

const temporaryDirectories: string[] = []

async function temporaryDirectory() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "convax-xyq-session-test-"))
  temporaryDirectories.push(directory)
  return directory
}

function session(overrides: Partial<StoredWebSession> = {}): StoredWebSession {
  return {
    authorizedAt: 1_784_390_400_000,
    cookies: [{
      domain: "",
      expiresAt: 1_800_000_000_000,
      name: "sessionid_pippitcn_web",
      path: "/",
      secure: true,
      value: "private-web-session-cookie",
    }],
    revision: "12345678-1234-1234-9234-123456789abc",
    schema: webSessionSchema,
    ...overrides,
  }
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, {
    force: true,
    recursive: true,
  })))
})

describe("XiaoYunque private Web session store", () => {
  test("atomically persists a strict session with private directory and file modes", async () => {
    const directory = await temporaryDirectory()
    const filePath = path.join(directory, "private", "web-session.json")
    const store = new FileWebSessionStore(filePath)

    await store.write(session())

    expect(await store.read()).toEqual(session())
    expect((await lstat(path.dirname(filePath))).mode & 0o777).toBe(0o700)
    expect((await lstat(filePath)).mode & 0o777).toBe(0o600)
    expect(await readFile(filePath, "utf8")).toContain("private-web-session-cookie")
  })

  test("keeps a legacy unsuffixed session readable without making it a browser capture name", async () => {
    const directory = await temporaryDirectory()
    const store = new FileWebSessionStore(path.join(directory, "web-session.json"))
    const legacy = session({
      cookies: [{ ...session().cookies[0]!, name: "sessionid" }],
    })

    await store.write(legacy)

    expect(await store.read()).toEqual(legacy)
  })

  test("fails closed for broad permissions and over-limit session files", async () => {
    const directory = await temporaryDirectory()
    const filePath = path.join(directory, "web-session.json")
    const store = new FileWebSessionStore(filePath)
    await store.write(session())

    await chmod(filePath, 0o644)
    await expect(store.read()).rejects.toThrow("local XiaoYunque Web session")

    await writeFile(filePath, "x".repeat(65 * 1024), { mode: 0o600 })
    await chmod(filePath, 0o600)
    await expect(store.read()).rejects.toThrow("local XiaoYunque Web session")
  })

  test("never follows a symlink and explicit clear repairs it without touching the target", async () => {
    const directory = await temporaryDirectory()
    const target = path.join(directory, "outside.json")
    const filePath = path.join(directory, "web-session.json")
    await writeFile(target, "outside-must-survive\n", { mode: 0o600 })
    await symlink(target, filePath)
    const store = new FileWebSessionStore(filePath)

    await expect(store.read()).rejects.toThrow("local XiaoYunque Web session")
    await expect(store.write(session())).rejects.toThrow("local XiaoYunque Web session")
    await store.clear()

    expect(await readFile(target, "utf8")).toBe("outside-must-survive\n")
    await store.write(session())
    expect((await lstat(filePath)).isSymbolicLink()).toBeFalse()
    expect(await store.read()).toEqual(session())
  })

  test("rejects duplicate, non-whitelisted, and unbounded Cookie fields", async () => {
    const directory = await temporaryDirectory()
    const store = new FileWebSessionStore(path.join(directory, "web-session.json"))
    const duplicate = session({
      cookies: [session().cookies[0]!, { ...session().cookies[0]!, value: "other" }],
    })

    await expect(store.write(duplicate)).rejects.toThrow("local XiaoYunque Web session")
    await expect(store.write(session({
      cookies: [{ ...session().cookies[0]!, name: "passport_csrf_token" }],
    }))).rejects.toThrow("local XiaoYunque Web session")
    await expect(store.write(session({
      cookies: [{ ...session().cookies[0]!, domain: ".jianying.com" }],
    }))).rejects.toThrow("local XiaoYunque Web session")
    await expect(store.write(session({
      cookies: [{ ...session().cookies[0]!, value: "x".repeat(16 * 1024 + 1) }],
    }))).rejects.toThrow("local XiaoYunque Web session")
  })
})
