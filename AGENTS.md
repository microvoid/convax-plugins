# Convax Plugins contributor contract

These rules apply to people and AI agents in this repository.

## Before editing

1. Read `README.md` and the relevant file in `docs/`.
2. Name the package being changed. A package owns only files below its own directory.
3. Never copy private Convax implementation code. Use only the documented manifest
   and `convax.plugin-host/1` protocol.

## Package rules

- Plugin and Skill sources live under `packages/plugins/<id>` and
  `packages/skills/<id>` respectively.
- The contents of `package/`, not the containing directory, become the ZIP root.
- A Plugin is static Web content. Do not add servers, native binaries, Electron,
  Node access, remote scripts, or install/build hooks.
- A Skill composes documented host capabilities. It must not claim capabilities,
  edit private `.convax` state, or ask users to bypass safety controls.
- Do not use symlinks, absolute paths, traversal, Windows-reserved names, generated
  dependency trees, secrets, or files larger than repository limits.
- Increment package SemVer whenever released bytes or catalog metadata change.
- Bump `registry/config.json` sequence for every published catalog change.

## Required verification

Run `bun run validate`, `bun test`, `bun run pack`, and `bun run build:index`
before requesting review. Do not execute contributor-provided scripts while
reviewing, validating, or packing a package. Tooling treats package contents as
inert bytes.

## Git discipline

- Every commit must have fewer than 1,000 changed lines (`added + deleted`). Split
  larger work by coherent behavior, never by arbitrary file fragments.
- Use conventional messages such as `feat(plugin): add storyboard surface`.
- Do not commit `dist/`, credentials, local Convax state, or dependencies.
- Publishing happens only from protected workflows after CI succeeds.

## Security

Keep workflow permissions minimal and pin every Action to a full commit SHA. Do not
weaken validation, digest checking, iframe isolation, or scope enforcement to make a
package pass. Report vulnerabilities through `SECURITY.md`, not a public issue.
