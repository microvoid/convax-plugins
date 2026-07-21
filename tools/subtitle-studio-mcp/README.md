# Subtitle Studio companion

This package is the local `mcp-stdio` runtime for the Subtitle Studio Plugin. It
owns subtitle parsing, audio transcription, soft-subtitle remuxing, preview
generation, and the reviewed AI hard-subtitle erasure pipeline. Convax Desktop
only stages scoped inputs and admits outputs; it does not contain Subtitle Studio
process, model, or product code.

## Development

```bash
bun install --frozen-lockfile
bun run typecheck
bun test
bun run build:release:darwin-arm64
```

Tests use fake executables and fixtures. They do not consult `PATH`, Homebrew, or
machine-local media/model installations.

## Installed runtime layout

The compiled `convax-subtitle-studio-mcp` executable accepts only a fixed sibling
runtime tree:

```text
convax-subtitle-studio-mcp
runtime/
  inventory.json
  ... pinned FFmpeg, FFprobe, Whisper, models, and hard-erasure sidecar ...
```

`inventory.json` uses `convax.subtitle-runtime/1` and pins every file by portable
relative path, exact byte size, and SHA-256. Startup verifies the complete tree;
each operation rechecks executable identity before use. Missing, substituted,
symlinked, incomplete, or ambient dependencies fail closed.

The repository currently carries the runtime contract and native source, not a
publishable dependency bundle. Do not create `plugin-subtitle-studio-v0.4.0` until
the Registry release pipeline installs this complete sibling tree, satisfies the
128 MiB companion policy (or a reviewed replacement policy), includes third-party
notices, signs the macOS output, and passes packaged real-media smoke tests.
