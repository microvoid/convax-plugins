# Convax FFmpeg MCP companion

This reviewed sidecar is distributed separately from the inert `ffmpeg-tools`
Plugin ZIP. It exposes three newline-delimited MCP tools (`run.image`, `run.video`,
and `run.audio`) and executes a pinned, source-built FFmpeg without a shell.

The caller supplies JSON argv tokens with exact staged-input and output
placeholders. Native paths and URL operands are never part of the public tool
input. The sidecar returns only relative artifact declarations; Convax validates
and admits those files into managed Project assets.

## Development

```sh
bun install
bun typecheck
bun test
bun run build
```

This first version is pinned to the official FFmpeg 8.1.2 source archive. It does
not redistribute an unknown community build. `build` verifies the fixed source
URL, byte size, and SHA-256, compiles FFmpeg on a native Darwin arm64 runner with
the reviewed local-only configuration, rejects GPL, version-3, nonfree, network,
device, playlist, segmented, and multi-output components, and checks that only
Apple system libraries are linked. Production Release builds additionally verify
the pinned upstream signature and signing-key fingerprint.

The published companion is one native arm64 Mach-O executable targeting macOS
13.0. A small Swift MCP launcher embeds the source-built FFmpeg Mach-O and its
SHA-256 in dedicated Mach-O sections. At execution time it verifies those bytes,
materializes FFmpeg in a private temporary directory outside the host output
scope, invokes it directly without a shell, and removes the temporary executable.
Bun is used only for build orchestration and tests; the published companion has no
Bun or JavaScript runtime dependency.

The same build then starts the native companion, completes MCP initialization,
and exercises image, audio, video trim, video crop, and frame-extraction tools
through the real MCP-to-FFmpeg artifact flow. It also checks both embedded and
outer deployment targets, Mach-O architecture, linked frameworks, compiled format
deny-lists, output limits, and the absence of JavaScriptCore, WebKit, or Bun
linkage. Development and Release builds use this same native-companion path.

The argv surface intentionally remains broad for ordinary FFmpeg transforms, but
it is not ambient process access. Inputs must be exact host-staged placeholders
whose bytes match a supported media signature. Network protocols, pipes, path
operands, path-opening filters/options, device access, and playlist/segmented or
multi-output formats are blocked. The host supplies a new empty output directory;
the companion continuously permits only one declared regular output and enforces
a size below 2 GiB.

The source currently publishes only the `darwin-arm64` companion target. Other
platforms are not claimed as supported until each has a reviewed native build,
declaration, and equivalent smoke checks.

## Licensing

The Plugin and separately authored sidecar code use the MIT License. The embedded
FFmpeg bytes and corresponding source remain under FFmpeg's applicable
LGPL-2.1-or-later and permissive terms. The reviewed configuration does not enable
GPL, version 3, or nonfree components. Keeping this Plugin separate from Convax
does not remove the obligations created by distributing the companion. See
`THIRD_PARTY_NOTICES.md` for the exact upstream release, corresponding source,
and production Release requirements.
