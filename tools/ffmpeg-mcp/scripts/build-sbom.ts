import { createHash } from "node:crypto"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import path from "node:path"

import { ffmpegSource } from "./ffmpeg-targets.ts"

interface Options {
  companion: string
  output: string
  revision: string
  tag: string
}

function options(argv: readonly string[]): Options {
  const values = new Map<string, string>()
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index]
    const value = argv[index + 1]
    if (!key?.startsWith("--") || !value) throw new Error("SBOM arguments must be --key value pairs")
    values.set(key.slice(2), value)
  }
  const companion = values.get("companion")
  const output = values.get("output")
  const revision = values.get("revision")
  const tag = values.get("tag")
  if (!companion || !output || !revision || !tag || values.size !== 4 || !/^[0-9a-f]{40}$/u.test(revision)) {
    throw new Error("Usage: build-sbom.ts --companion PATH --output PATH --revision 40_HEX --tag TAG")
  }
  return { companion, output, revision, tag }
}

const selected = options(process.argv.slice(2))
const epoch = Number(Bun.env.SOURCE_DATE_EPOCH)
if (!Number.isSafeInteger(epoch) || epoch <= 0) throw new Error("SOURCE_DATE_EPOCH must be a positive Unix timestamp")
const companion = await readFile(selected.companion)
if (companion.length === 0 || companion.length >= 128 * 1024 * 1024) {
  throw new Error("SBOM companion input must be a non-empty native Release executable")
}
const companionSha256 = createHash("sha256").update(companion).digest("hex")
const version = /^plugin-ffmpeg-tools-v(.+)$/u.exec(selected.tag)?.[1]
if (!version) throw new Error("SBOM tag must identify the FFmpeg Plugin Release")

const document = {
  SPDXID: "SPDXRef-DOCUMENT",
  creationInfo: {
    created: new Date(epoch * 1_000).toISOString().replace(".000Z", "Z"),
    creators: ["Organization: Microvoid contributors", "Tool: convax-ffmpeg-sbom/1"],
  },
  dataLicense: "CC0-1.0",
  documentNamespace:
    `https://github.com/microvoid/convax-plugins/releases/download/${selected.tag}/sbom-${selected.revision}`,
  name: `convax-ffmpeg-mcp-${version}`,
  packages: [
    {
      SPDXID: "SPDXRef-Package-convax-ffmpeg-mcp",
      checksums: [{ algorithm: "SHA256", checksumValue: companionSha256 }],
      copyrightText: "Copyright (c) 2026 Microvoid contributors",
      downloadLocation: "NOASSERTION",
      filesAnalyzed: false,
      licenseConcluded: "MIT",
      licenseDeclared: "MIT",
      name: "convax-ffmpeg-mcp",
      primaryPackagePurpose: "APPLICATION",
      supplier: "Organization: Microvoid contributors",
      versionInfo: version,
    },
    {
      SPDXID: "SPDXRef-Package-FFmpeg",
      checksums: [{ algorithm: "SHA256", checksumValue: ffmpegSource.archiveSha256 }],
      copyrightText: "NOASSERTION",
      downloadLocation: ffmpegSource.archiveUrl,
      externalRefs: [{
        referenceCategory: "PACKAGE-MANAGER",
        referenceLocator: `pkg:generic/ffmpeg@${ffmpegSource.version}`,
        referenceType: "purl",
      }],
      filesAnalyzed: false,
      licenseComments: "The reviewed build disables GPL, version3, nonfree, network, devices, playlist demuxers, and multi-file muxers; FFmpeg also contains compatible permissive files.",
      licenseConcluded: "LGPL-2.1-or-later",
      licenseDeclared: "LGPL-2.1-or-later",
      name: "FFmpeg",
      packageFileName: `${ffmpegSource.directory}.tar.xz`,
      primaryPackagePurpose: "LIBRARY",
      supplier: "Organization: FFmpeg project",
      versionInfo: ffmpegSource.version,
    },
  ],
  relationships: [
    {
      relatedSpdxElement: "SPDXRef-Package-convax-ffmpeg-mcp",
      relationshipType: "DESCRIBES",
      spdxElementId: "SPDXRef-DOCUMENT",
    },
    {
      relatedSpdxElement: "SPDXRef-Package-FFmpeg",
      relationshipType: "CONTAINS",
      spdxElementId: "SPDXRef-Package-convax-ffmpeg-mcp",
    },
  ],
  spdxVersion: "SPDX-2.3",
}

await mkdir(path.dirname(selected.output), { recursive: true })
await writeFile(selected.output, `${JSON.stringify(document, null, 2)}\n`, { mode: 0o644 })
console.log(`Built deterministic SPDX SBOM ${selected.output}`)
