# Packaging and publishing

Repository tooling reads package files as inert bytes. It never runs a package's
scripts, installs its dependencies, or follows symlinks.

The repository is a Bun monorepo. Every Plugin, Skill, and Tool owns a workspace
`package.json`, while one root `bun.lock` freezes the complete dependency graph.
CI runs one `bun install --frozen-lockfile --ignore-scripts`; validation and packing
remain separate inert-byte operations and never install dependencies themselves. A
trusted `workspaces:build:packages` phase runs first for workspaces that declare
`build`; each build must emit a complete self-contained `package/` tree. Released
archives never contain `node_modules` and installation never runs a package manager.

## Source and ZIP roots

```text
packages/<kind>/<id>/convax-package.json  # catalog metadata, not shipped
packages/<kind>/<id>/package.json         # workspace dependencies/scripts, not shipped
packages/<kind>/<id>/package/             # exact ZIP root
packages/<kind>/<id>/showcase/            # optional catalog media, not shipped
```

Plugin ZIPs require root `manifest.json`; Skill ZIPs require root `SKILL.md`.
Entries are sorted by UTF-8 path, stored with fixed timestamps/modes, and use the ZIP
STORE method. Thus identical source bytes produce identical SHA-256 digests across
machines. Uncompressed storage is intentional: packages are already size-bounded,
and avoiding compressor-version drift makes releases reproducible.

A headless `convax.plugin/2`, `convax.plugin/3`, `convax.plugin/4`, or `convax.plugin/5` Tool Plugin may contain only `manifest.json` and a
license notice. Its generation and/or service contribution uses one declared
`mcp-stdio` executable that is a separate distributable and
must never appear anywhere below `package/`; validation and packing do not install,
build, or execute companion source under `packages/tools/`.

## Pet Plugin assets

A pet-only `convax.plugin/5` package is also inert. Its ZIP may contain the
manifest, license and documentation, plus the PNG or WebP referenced by
`contributes.pet.spritesheet`; it must not contain an HTML entry, runtime,
executable, dependency tree, installer, remote script, or server. Pet Plugins use
the transport-neutral `convax.plugin-capability/1` compatibility pair and do not
receive a host port.

For `spriteVersion: 2`, the sprite sheet is exactly 1536×1872 pixels: eight columns
of 192-pixel cells and nine rows of 208-pixel cells. The ordinary 2 MiB per-file
limit still applies. Keep asset paths package-relative and let Convax inspect
dimensions, format, transparency, and decoded image safety before installation.
The Plugin contributes appearance only; the host owns the floating window and all
Agent activity data.

The matching source metadata declares the reviewed tool directory and build output
for each target. For example:

```json
"companions": [{
  "command": "creative-tools-mcp",
  "version": "1.2.3",
  "source": "packages/tools/creative-tools-mcp",
  "targets": [{
    "platform": "darwin",
    "arch": "arm64",
    "path": "dist/darwin-arm64/creative-tools-mcp"
  }]
}]
```

`source` is exactly one workspace below `packages/tools/`; target `path` is relative to it.
Both are publishing inputs and never enter the Registry or Plugin ZIP. Packing
rejects missing files, symlinks at any path component, non-files, oversized files,
non-executable POSIX artifacts, duplicate targets, and files resolving outside the
reviewed source. It derives size and SHA-256 from the bytes it copies rather than
trusting contributor-authored values.

Each reviewed tool exposes one `build:release:<platform>-<arch>` package script per
declared target. `bun run build:companions` discovers those declarations and invokes
only that fixed reviewed script name (never a command supplied by package metadata),
then immediately applies the same path, symlink, executable-mode, size, and digest
admission checks used by packing.

## Plugin-owned Skill composition

A `convax.plugin/4` or `convax.plugin/5` manifest may declare `contributes.skills` entries such as
`{"name":"ffmpeg-canvas","path":"skills/ffmpeg-canvas"}`. The named Skill remains
an independent workspace and standard portable Skill package. Its source metadata
declares `ownerPluginId`.

The Plugin directory must not contain a copied Skill tree. Discovery verifies the
two ownership declarations, reads the Skill workspace as inert bytes, and injects
those bytes below the declared Plugin ZIP path. The resulting ZIP is deterministic,
while the source of truth remains singular. npm workspace dependencies are build
relationships only and never imply Convax lifecycle ownership.

Changing an owned Skill changes both its portable Skill ZIP and the owner Plugin ZIP.
Both versions must be bumped and released. Catalog deployment recomputes every
deterministic source ZIP and requires its size and SHA-256 to match the immutable
Release entry, preventing an old owner Plugin from being paired with a newer Skill
presentation artifact.

Paths must be portable POSIX relative paths. Symlinks, traversal, control characters,
Windows device names, alternate data streams, case/Unicode-normalization collisions,
files over 2 MiB, combined packages over 10 MiB, Plugin inventories over 2,000
entries, and Skill inventories over 512 entries are rejected. Runtime CDN URLs, executable file
modes, native extensions, shebang scripts, and packaged Node/server entrypoints are
rejected for Plugins.

## Local output

Run the explicitly reviewed companion build before packing packages that declare
one; packing itself never executes tool source:

```sh
bun run build:companions
bun run pack
```

`bun run pack -- --kind plugin --id hello-convax` writes a versioned ZIP and
`registry-entry.json` below `dist/packages/`. `bun run build:index` reads those
entries and writes `dist/registry/v1/index.json`. A package with `showcase`
metadata also produces `showcase-entry.json` and versioned poster/animation assets;
the index build writes `dist/showcase/v1/index.json` with the same sequence and
revision as the Registry. A package with `companions` additionally produces one
standalone `convax-companion-*` Release asset per target; the Registry entry records
its immutable URL, exact byte size, and SHA-256.

## Release

Publish a reviewed package by pushing an annotated tag:

```sh
git tag -a plugin-hello-convax-v0.1.0 -m "hello-convax 0.1.0"
git push origin plugin-hello-convax-v0.1.0
```

Push batch tags in separate `git push` invocations and confirm that every tag
creates a **Publish package** run. GitHub does not create tag push events when more
than three tags are pushed at once, so a single bulk push can leave valid tags with
no Releases. See GitHub's
[push event documentation](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#push).

The tag must match source metadata exactly. The workflow validates all packages,
cross-compiles the reviewed target, packs only the tagged package, attests its ZIP
and each companion, creates a draft Release, uploads the ZIP plus
`registry-entry.json`, companions, and any declared Showcase assets, and only then
publishes it. Published versions are
immutable; never move or reuse a tag. Change bytes by publishing a higher SemVer. To
disable a compromised version, add its `kind/id@version` identity to
`registry/config.json`, bump the Registry sequence, and manually run the protected
Pages workflow. This changes catalog policy without replacing the old asset.

The Pages workflow aggregates entry documents from GitHub Releases and publishes
only valid entries. The production catalog is:

`https://microvoid.github.io/convax-plugins/registry/v1/index.json`

The matching presentation sidecar is:

`https://microvoid.github.io/convax-plugins/showcase/v1/index.json`

Registry deployment is atomic with respect to the package versions on `main`.
Pages waits until every source package has a matching published Release, so a batch
of package tags becomes visible as one catalog update under a single new Registry
sequence instead of exposing partially published batches.
