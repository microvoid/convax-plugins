# Subtitle Studio companion contract

This directory owns the separately distributed Subtitle Studio companion and its
headless subtitle domain. It never enters a Plugin ZIP and must not be imported by
Convax application packages.

## Current scope

- `src/domain` owns the portable subtitle document, SRT, translation batching and
  response validation, host-neutral job state, media inspection, and erase-plan
  semantics.
- Domain code must stay deterministic and side-effect free. It must not import
  Convax packages, Electron, Node filesystem/process APIs, native paths, MCP
  transport, model runtimes, FFmpeg, OCR, Whisper, or inpainting implementations.
- Keep the existing versioned subtitle schemas compatible unless an explicit,
  tested migration is added.

## Runtime boundary

- MCP, media-process, and native/model adapters remain outside `src/domain` and
  consume only its exported operations.
- The stdio server follows the repository's companion security contract:
  bounded MCP messages on stdout, no native paths or command lines in results, no
  shell evaluation, exact host-staged inputs, exact host-owned outputs, and
  cancellation that terminates active work.
- Runtime files come only from the strict sibling `runtime/inventory.json` tree.
  Every executable and model is pinned by relative path, exact size and SHA-256,
  stays inside the companion root, and is rechecked before use. PATH, Homebrew,
  environment overrides and Convax Desktop resources are not fallbacks.
- Native/model dependencies are reviewed release assets, never Plugin package
  contents. Do not publish a tag until the release pipeline installs the complete
  inventory and passes the package's release gate.

Run `bun typecheck`, `bun test`, and the declared release build before handoff.
