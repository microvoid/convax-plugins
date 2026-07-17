import { promises as fs } from "node:fs"
import path from "node:path"
import { assetNameFor, parseArgs, parseRegistryEntry, repository, root } from "./lib.mjs"

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
      const asset = release.assets?.find((candidate) => candidate.name === "registry-entry.json")
      if (!asset) continue
      const assetResponse = await githubJson(asset.url, token, "application/octet-stream", fetchImpl)
      const text = await assetResponse.text()
      const entry = parseRegistryEntry(JSON.parse(text), `Release ${release.tag_name}`)
      const expectedTag = `${entry.kind}-${entry.id}-v${entry.version}`
      if (release.tag_name !== expectedTag) throw new Error(`Release ${release.tag_name}: entry expects ${expectedTag}`)
      const zipName = assetNameFor(entry)
      const zipAsset = release.assets?.find((candidate) => candidate.name === zipName)
      if (!zipAsset) throw new Error(`Release ${release.tag_name}: missing ${zipName}`)
      if (zipAsset.size !== entry.artifact.size) {
        throw new Error(`Release ${release.tag_name}: ${zipName} size does not match Registry entry`)
      }
      await fs.mkdir(path.join(outputDirectory, expectedTag), { recursive: true })
      await fs.writeFile(path.join(outputDirectory, expectedTag, "registry-entry.json"), text.endsWith("\n") ? text : `${text}\n`)
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
