# Convax Plugins contributor contract

These rules apply to people and AI agents in this repository.

## Before editing

1. Read `README.md` and the relevant file in `docs/`.
2. Name the package or external tool being changed. A package owns only files below
   its own workspace; a separately distributed tool owns only `packages/tools/<id>`.
3. Never copy private Convax implementation code. Use only the documented manifest
   and version-matched `convax.plugin-host/1`, `convax.plugin-host/2`,
   `convax.plugin-host/3`, or `convax.plugin-host/4` protocol.

## Package rules

- Plugin and Skill sources live under `packages/plugins/<id>` and
  `packages/skills/<id>` respectively.
- Every Plugin, Skill, and Tool directory is a Bun workspace with its own
  `package.json`, dependency declarations, and scripts. The repository owns one
  root `bun.lock`; do not add package-local lockfiles or hard-code workspace ids in CI.
- The contents of `package/`, not the containing directory, become the ZIP root.
- A `convax.plugin/1` Plugin is static Web content. A `convax.plugin/2` or
  `convax.plugin/3` package may
  additionally declare a separately installed bare `mcp-stdio` command and
  generation tools. Never put that executable, a server, native binary, Electron,
  Node access, remote script, dependency tree, or install/build hook in the Plugin
  ZIP.
- Reviewed companion tool source may live under `packages/tools/<id>`, but it is a separate
  distributable with its own tests. Repository validation and Plugin packing never
  execute it or include it in `package/`.
- A `convax.plugin/4` Plugin may contribute Plugin-owned Skills from independent
  Skill workspaces. The packer injects them; do not commit a duplicate Skill below
  the Plugin `package/`. Convax lifecycle ownership is declared by the manifest and
  Registry metadata, never inferred from npm dependencies.
- A published companion is declared in source metadata and emitted as a separate,
  target-specific Release asset. Its immutable Registry URL, byte size, and SHA-256
  are derived from the reviewed build output; never author them by hand.
- A Skill composes documented host capabilities. It must not claim capabilities,
  edit private `.convax` state, or ask users to bypass safety controls.
- Do not use symlinks, absolute paths, traversal, Windows-reserved names, generated
  dependency trees, secrets, or files larger than repository limits.
- Increment package SemVer whenever released bytes or catalog metadata change.
- Bump `registry/config.json` sequence for every published catalog change.
- A generation companion must not impose an arbitrary overall deadline after a
  vendor accepts a job. Bound individual status requests and keep canonical
  queued/running states alive until success, explicit terminal failure, or caller
  cancellation.

## Required verification

Run `bun install --frozen-lockfile --ignore-scripts`, trusted Plugin/Skill workspace
builds, `bun run validate`, workspace tests, `bun run build:companions`, `bun test`,
`bun run pack`, and `bun run build:index` before requesting review. The explicit
package and companion build phases finish before validation and packing. Validation
and packing themselves remain inert and never execute contributor-provided scripts.
Tooling treats package contents as inert bytes.

## Git discipline

- Use conventional messages such as `feat(plugin): add storyboard surface`.
- Do not commit `dist/`, credentials, local Convax state, or dependencies.
- Publishing happens only from protected workflows after CI succeeds.

## Security

Keep workflow permissions minimal and pin every Action to a full commit SHA. Do not
weaken validation, digest checking, iframe isolation, or scope enforcement to make a
package pass. Report vulnerabilities through `SECURITY.md`, not a public issue.
