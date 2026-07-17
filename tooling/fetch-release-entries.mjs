import { promises as fs } from "node:fs"
import path from "node:path"
import {
  assetNameFor,
  inspectShowcaseMedia,
  json,
  parseArgs,
  parseRegistryEntry,
  parseShowcaseEntry,
  repository,
  root,
  sha256,
  showcaseAssetNameFor,
} from "./lib.mjs"

async function githubJson(url, token, accept, fetchImpl) {
  const response = await fetchImpl(url, {
    headers: {
      Accept: accept,
      Authorization: `Bearer ${token}`,
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "convax-registry-builder",
    },
    redirect: "follow",
  })
  if (!response.ok) throw new Error(`GitHub API ${response.status}: ${url}`)
  return response
}

function findAsset(release, name, required = true) {
  if (!Array.isArray(release.assets)) throw new Error(`Release ${release.tag_name}: assets must be an array`)
  const matches = release.assets.filter((candidate) => candidate?.name === name)
  if (matches.length > 1) throw new Error(`Release ${release.tag_name}: duplicate ${name}`)
  if (required && matches.length === 0) throw new Error(`Release ${release.tag_name}: missing ${name}`)
  return matches[0]
}

async function verifyShowcaseMedia(release, entry, role, token, fetchImpl) {
  const media = entry[role]
  if (!media) return
  const assetName = showcaseAssetNameFor(entry, role, media.mime)
  const asset = findAsset(release, assetName)
  if (asset.size !== media.size) throw new Error(`Release ${release.tag_name}: ${assetName} size does not match Showcase entry`)
  if (asset.content_type !== media.mime) throw new Error(`Release ${release.tag_name}: ${assetName} MIME type does not match Showcase entry`)
  if (asset.browser_download_url !== media.url) throw new Error(`Release ${release.tag_name}: ${assetName} download URL does not match Showcase entry`)
  if (asset.digest !== undefined && asset.digest !== `sha256:${media.sha256}`) {
    throw new Error(`Release ${release.tag_name}: ${assetName} digest does not match Showcase entry`)
  }
  const response = await githubJson(asset.url, token, "application/octet-stream", fetchImpl)
  const data = Buffer.from(await response.arrayBuffer())
  if (data.length !== media.size) throw new Error(`Release ${release.tag_name}: downloaded ${assetName} size does not match Showcase entry`)
  if (sha256(data) !== media.sha256) throw new Error(`Release ${release.tag_name}: ${assetName} SHA-256 does not match Showcase entry`)
  const dimensions = inspectShowcaseMedia(data, media.mime, `Release ${release.tag_name} ${assetName}`)
  if (dimensions.width !== media.width || dimensions.height !== media.height) {
    throw new Error(`Release ${release.tag_name}: ${assetName} dimensions do not match Showcase entry`)
  }
}

export async function fetchReleaseEntries({ outputDirectory, token, fetchImpl = globalThis.fetch }) {
  if (!token) throw new Error("GITHUB_TOKEN is required")
  await fs.rm(outputDirectory, { recursive: true, force: true })
  await fs.mkdir(outputDirectory, { recursive: true })
  let count = 0
  for (let page = 1; ; page += 1) {
    const response = await githubJson(
      `https://api.github.com/repos/${repository}/releases?per_page=100&page=${page}`,
      token,
      "application/vnd.github+json",
      fetchImpl,
    )
    const releases = await response.json()
    if (!Array.isArray(releases)) throw new Error("GitHub releases response is not an array")
    for (const release of releases) {
      if (release.draft) continue
      const asset = findAsset(release, "registry-entry.json", false)
      if (!asset) continue
      const assetResponse = await githubJson(asset.url, token, "application/octet-stream", fetchImpl)
      const text = await assetResponse.text()
      const entry = parseRegistryEntry(JSON.parse(text), `Release ${release.tag_name}`)
      const expectedTag = `${entry.kind}-${entry.id}-v${entry.version}`
      if (release.tag_name !== expectedTag) throw new Error(`Release ${release.tag_name}: entry expects ${expectedTag}`)
      const zipName = assetNameFor(entry)
      const zipAsset = findAsset(release, zipName)
      if (zipAsset.size !== entry.artifact.size) {
        throw new Error(`Release ${release.tag_name}: ${zipName} size does not match Registry entry`)
      }
      await fs.mkdir(path.join(outputDirectory, expectedTag), { recursive: true })
      await fs.writeFile(path.join(outputDirectory, expectedTag, "registry-entry.json"), text.endsWith("\n") ? text : `${text}\n`)

      const showcaseAsset = findAsset(release, "showcase-entry.json", false)
      const reservedAssets = release.assets.filter((candidate) => candidate?.name?.startsWith("convax-showcase-"))
      if (!showcaseAsset && reservedAssets.length > 0) {
        throw new Error(`Release ${release.tag_name}: Showcase media requires showcase-entry.json`)
      }
      if (showcaseAsset) {
        const showcaseResponse = await githubJson(showcaseAsset.url, token, "application/octet-stream", fetchImpl)
        const showcase = parseShowcaseEntry(JSON.parse(await showcaseResponse.text()), `Release ${release.tag_name} Showcase entry`)
        if (showcase.kind !== entry.kind || showcase.id !== entry.id || showcase.version !== entry.version) {
          throw new Error(`Release ${release.tag_name}: Showcase identity does not match Registry entry`)
        }
        await verifyShowcaseMedia(release, showcase, "poster", token, fetchImpl)
        await verifyShowcaseMedia(release, showcase, "animation", token, fetchImpl)
        const expectedMediaCount = showcase.animation ? 2 : 1
        if (reservedAssets.length !== expectedMediaCount) {
          throw new Error(`Release ${release.tag_name}: unexpected Showcase media asset`)
        }
        await fs.writeFile(path.join(outputDirectory, expectedTag, "showcase-entry.json"), json(showcase))
      }
      count += 1
    }
    if (releases.length < 100) break
  }
  if (count === 0) throw new Error("No published Registry entries were found")
  return count
}

if (import.meta.main) {
  const args = parseArgs(process.argv.slice(2).filter((argument) => argument !== "--"))
  const unknown = Object.keys(args).find((key) => key !== "output")
  if (unknown) throw new Error(`arguments: unsupported --${unknown}`)
  const count = await fetchReleaseEntries({
    outputDirectory: path.resolve(root, args.output ?? "dist/release-entries"),
    token: process.env.GITHUB_TOKEN,
  })
  console.log(`Fetched ${count} published Registry entries.`)
}
