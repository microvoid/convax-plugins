import { afterAll, describe, expect, test } from "bun:test"
import { promises as fs } from "node:fs"
import os from "node:os"
import path from "node:path"
import { buildIndex } from "./build-index.mjs"
import { buildShowcase } from "./build-showcase.mjs"
import { checkReleaseCoverage } from "./check-release-coverage.mjs"
import { fetchReleaseEntries } from "./fetch-release-entries.mjs"
import {
  inspectShowcaseMedia,
  loadShowcaseAssets,
  parseShowcase,
  parseShowcaseEntry,
  parseSourceMetadata,
  readStoredZip,
  sha256,
} from "./lib.mjs"
import { packPackages } from "./pack.mjs"

const temporaryDirectories = []
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64")

async function temporaryDirectory() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "convax-showcase-"))
  temporaryDirectories.push(directory)
  return directory
}

async function showcasePackage() {
  const directory = await temporaryDirectory()
  await fs.mkdir(path.join(directory, "showcase"))
  await fs.writeFile(path.join(directory, "showcase/poster.png"), png)
  const metadata = parseSourceMetadata({
    schema: "convax.package/1",
    kind: "skill",
    id: "showcase-test",
    name: "Showcase Test",
    description: "Exercises the independent Showcase release path.",
    version: "1.2.3",
    license: "MIT",
    compatibility: { skillSchema: "opencode.skill/1" },
    yanked: false,
    showcase: {
      poster: {
        path: "showcase/poster.png",
        alt: "A small test poster.",
        mime: "image/png",
        width: 1,
        height: 1,
      },
    },
  })
  return {
    directory,
    files: [{ relativePath: "SKILL.md", data: Buffer.from("---\nname: showcase-test\ndescription: Test.\n---\n\n# Test\n") }],
    metadata,
    showcase: await loadShowcaseAssets(metadata, directory),
  }
}

function mp4(width, height) {
  const data = Buffer.alloc(104)
  data.writeUInt32BE(20, 0)
  data.write("ftyp", 4)
  data.writeUInt32BE(84, 20)
  data.write("tkhd", 24)
  data.writeUInt32BE(width << 16, 96)
  data.writeUInt32BE(height << 16, 100)
  return data
}

function releaseFixture(packed) {
  const poster = { ...packed.showcaseAssets[0], data: Buffer.from(packed.showcaseAssets[0].data) }
  const release = {
    assets: [
      { name: "registry-entry.json", url: "https://api.github.test/registry" },
      { name: packed.assetName, size: packed.zip.length },
      { name: "showcase-entry.json", url: "https://api.github.test/showcase" },
      {
        name: poster.assetName,
        url: "https://api.github.test/poster",
        browser_download_url: packed.showcaseEntry.poster.url,
        content_type: "image/png",
        digest: `sha256:${sha256(poster.data)}`,
        size: poster.data.length,
      },
    ],
    draft: false,
    tag_name: packed.tag,
  }
  const fetchImpl = async (url) => {
    if (String(url).includes("/releases?")) return new Response(JSON.stringify([release]))
    if (url === "https://api.github.test/registry") return new Response(JSON.stringify(packed.entry))
    if (url === "https://api.github.test/showcase") return new Response(JSON.stringify(packed.showcaseEntry))
    if (url === "https://api.github.test/poster") return new Response(poster.data)
    throw new Error(`Unexpected URL ${url}`)
  }
  return { fetchImpl, poster, release }
}

afterAll(async () => {
  await Promise.all(temporaryDirectories.map((directory) => fs.rm(directory, { recursive: true, force: true })))
})

describe("Showcase source and packaging", () => {
  test("accepts only bounded portable media declarations", () => {
    const base = {
      schema: "convax.package/1", kind: "skill", id: "demo", name: "Demo", description: "Demo.", version: "1.0.0",
      license: "MIT", compatibility: { skillSchema: "opencode.skill/1" }, yanked: false,
      showcase: { poster: { path: "showcase/poster.png", alt: "Poster.", mime: "image/png", width: 1, height: 1 } },
    }
    expect(parseSourceMetadata(base).showcase.poster.path).toBe("showcase/poster.png")
    for (const [field, value, message] of [
      ["path", "../poster.png", "traversal segments"],
      ["path", "showcase/nested/poster.png", "directly below showcase"],
      ["mime", "text/html", "unsupported poster MIME"],
      ["width", 0, "integer from 1 to 8192"],
    ]) {
      const candidate = structuredClone(base)
      candidate.showcase.poster[field] = value
      expect(() => parseSourceMetadata(candidate)).toThrow(message)
    }
    const mismatched = structuredClone(base)
    mismatched.showcase.poster.mime = "image/jpeg"
    expect(() => parseSourceMetadata(mismatched)).toThrow("extension must be .jpg")
  })

  test("sniffs MIME signatures and dimensions instead of trusting metadata", () => {
    expect(inspectShowcaseMedia(png, "image/png")).toEqual({ width: 1, height: 1 })
    expect(inspectShowcaseMedia(mp4(1280, 720), "video/mp4")).toEqual({ width: 1280, height: 720 })
    expect(() => inspectShowcaseMedia(png, "image/webp")).toThrow("not a WebP")
  })

  test("keeps Showcase assets outside the install ZIP", async () => {
    const pkg = await showcasePackage()
    const [packed] = await packPackages([pkg], path.join(await temporaryDirectory(), "packed"))
    expect(readStoredZip(packed.zip).map((file) => file.relativePath)).toEqual(["SKILL.md"])
    expect(packed.entry).not.toHaveProperty("showcase")
    expect(parseShowcaseEntry(packed.showcaseEntry)).toEqual(packed.showcaseEntry)
    expect(await fs.readFile(packed.showcaseAssets[0].path)).toEqual(png)
    const hostile = structuredClone(packed.showcaseEntry)
    hostile.poster.url = hostile.poster.url.replace("https://github.com/", "https://example.com/")
    expect(() => parseShowcaseEntry(hostile)).toThrow("url must equal")
  })

  test("rejects missing, symlinked, and dimension-mismatched source assets", async () => {
    const pkg = await showcasePackage()
    await fs.rm(path.join(pkg.directory, "showcase/poster.png"))
    await expect(loadShowcaseAssets(pkg.metadata, pkg.directory)).rejects.toThrow()
    await fs.writeFile(path.join(pkg.directory, "showcase/poster.png"), png)
    pkg.metadata.showcase.poster.width = 2
    await expect(loadShowcaseAssets(pkg.metadata, pkg.directory)).rejects.toThrow("does not match 1x1")
    pkg.metadata.showcase.poster.width = 1
    await fs.rm(path.join(pkg.directory, "showcase/poster.png"))
    await fs.symlink(path.join(pkg.directory, "outside.png"), path.join(pkg.directory, "showcase/poster.png"))
    await expect(loadShowcaseAssets(pkg.metadata, pkg.directory)).rejects.toThrow("symlink is forbidden")
  })
})

describe("Showcase Release aggregation", () => {
  test("builds a sidecar with the Registry sequence and revision", async () => {
    const pkg = await showcasePackage()
    const directory = await temporaryDirectory()
    await packPackages([pkg], path.join(directory, "entries"))
    const registry = await buildIndex({
      entriesDirectory: path.join(directory, "entries"),
      outputFile: path.join(directory, "registry.json"),
      revision: "b".repeat(40),
      sequence: 9,
    })
    const showcase = await buildShowcase({
      entriesDirectory: path.join(directory, "entries"),
      outputFile: path.join(directory, "showcase.json"),
      registry,
    })
    expect(showcase.sequence).toBe(registry.sequence)
    expect(showcase.revision).toBe(registry.revision)
    expect(showcase.packages.map((item) => `${item.kind}/${item.id}@${item.version}`)).toEqual(["skill/showcase-test@1.2.3"])
    expect(registry.packages[0]).not.toHaveProperty("poster")
    expect(() => parseShowcase({ ...showcase, unexpected: true })).toThrow("unsupported field unexpected")
  })

  test("downloads and verifies every published media byte", async () => {
    const pkg = await showcasePackage()
    const [packed] = await packPackages([pkg], path.join(await temporaryDirectory(), "packed"))
    const fixture = releaseFixture(packed)
    const output = path.join(await temporaryDirectory(), "release-entries")
    expect(await fetchReleaseEntries({ outputDirectory: output, token: "test", fetchImpl: fixture.fetchImpl })).toBe(1)
    expect(parseShowcaseEntry(JSON.parse(await fs.readFile(path.join(output, packed.tag, "showcase-entry.json"))))).toEqual(packed.showcaseEntry)
  })

  test("rejects Release MIME, size, digest, hash, and dimension mismatches", async () => {
    const pkg = await showcasePackage()
    const [packed] = await packPackages([pkg], path.join(await temporaryDirectory(), "packed"))
    for (const [mutate, message] of [
      [(fixture) => { fixture.release.assets[3].content_type = "application/octet-stream" }, "MIME type does not match"],
      [(fixture) => { fixture.release.assets[3].size += 1 }, "size does not match"],
      [(fixture) => { fixture.release.assets[3].digest = `sha256:${"0".repeat(64)}` }, "digest does not match"],
      [(fixture) => { fixture.poster.data[fixture.poster.data.length - 1] ^= 1 }, "SHA-256 does not match"],
      [(fixture) => { packed.showcaseEntry.poster.width = 2 }, "dimensions do not match"],
    ]) {
      const fixture = releaseFixture(packed)
      mutate(fixture)
      await expect(fetchReleaseEntries({
        outputDirectory: path.join(await temporaryDirectory(), "release-entries"), token: "test", fetchImpl: fixture.fetchImpl,
      })).rejects.toThrow(message)
      packed.showcaseEntry.poster.width = 1
    }
  })

  test("rejects missing, orphaned, duplicate, and redirected Release assets", async () => {
    const pkg = await showcasePackage()
    const [packed] = await packPackages([pkg], path.join(await temporaryDirectory(), "packed"))
    for (const [mutate, message] of [
      [(fixture) => { fixture.release.assets.splice(3, 1) }, `missing ${packed.showcaseAssets[0].assetName}`],
      [(fixture) => { fixture.release.assets.splice(2, 1) }, "media requires showcase-entry.json"],
      [(fixture) => { fixture.release.assets.push({ ...fixture.release.assets[3] }) }, `duplicate ${packed.showcaseAssets[0].assetName}`],
      [(fixture) => { fixture.release.assets[3].browser_download_url = "https://example.com/poster.png" }, "download URL does not match"],
    ]) {
      const fixture = releaseFixture(packed)
      mutate(fixture)
      await expect(fetchReleaseEntries({
        outputDirectory: path.join(await temporaryDirectory(), "release-entries"), token: "test", fetchImpl: fixture.fetchImpl,
      })).rejects.toThrow(message)
    }
  })

  test("requires matching Showcase coverage before atomic deployment", async () => {
    const pkg = await showcasePackage()
    const directory = path.join(await temporaryDirectory(), "entries")
    const [packed] = await packPackages([pkg], directory)
    expect(await checkReleaseCoverage({ entriesDirectory: directory, packages: [pkg] })).toEqual({ missing: [], ready: true })
    const altered = structuredClone(packed.showcaseEntry)
    altered.poster.sha256 = "0".repeat(64)
    await fs.writeFile(packed.showcaseEntryPath, `${JSON.stringify(altered)}\n`)
    await expect(checkReleaseCoverage({ entriesDirectory: directory, packages: [pkg] })).rejects.toThrow("does not match source")
    await fs.writeFile(packed.showcaseEntryPath, `${JSON.stringify(packed.showcaseEntry)}\n`)
    await fs.rm(packed.showcaseEntryPath)
    expect(await checkReleaseCoverage({ entriesDirectory: directory, packages: [pkg] })).toEqual({ missing: [packed.tag], ready: false })
    await fs.writeFile(packed.showcaseEntryPath, `${JSON.stringify(packed.showcaseEntry)}\n`)
    const withoutShowcase = { ...pkg, metadata: { ...pkg.metadata }, showcase: undefined }
    delete withoutShowcase.metadata.showcase
    await expect(checkReleaseCoverage({ entriesDirectory: directory, packages: [withoutShowcase] })).rejects.toThrow("not declared")
  })
})
