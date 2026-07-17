# Packaging and publishing

Repository tooling reads package files as inert bytes. It never runs a package's
scripts, installs its dependencies, or follows symlinks.

## Source and ZIP roots

```text
packages/<kind>/<id>/convax-package.json  # catalog metadata, not shipped
packages/<kind>/<id>/package/             # exact ZIP root
```

Plugin ZIPs require root `manifest.json`; Skill ZIPs require root `SKILL.md`.
Entries are sorted by UTF-8 path, stored with fixed timestamps/modes, and use the ZIP
STORE method. Thus identical source bytes produce identical SHA-256 digests across
machines. Uncompressed storage is intentional: packages are already size-bounded,
and avoiding compressor-version drift makes releases reproducible.

Paths must be portable POSIX relative paths. Symlinks, traversal, control characters,
Windows device names, alternate data streams, case-insensitive collisions, files
over 2 MiB, and packages over 10 MiB are rejected. Runtime CDN URLs and executable
extensions are rejected for Plugins.

## Local output

`bun run pack -- --kind plugin --id hello-convax` writes a versioned ZIP and
`registry-entry.json` below `dist/packages/`. `bun run build:index` reads those
entries and writes `dist/registry/v1/index.json`.

## Release

Publish a reviewed package by pushing an annotated tag:

```sh
git tag -a plugin-hello-convax-v0.1.0 -m "hello-convax 0.1.0"
git push origin plugin-hello-convax-v0.1.0
```

The tag must match source metadata exactly. The workflow validates all packages,
packs only the tagged package, attests its ZIP, creates a draft Release, uploads the
ZIP plus `registry-entry.json`, and only then publishes it. Published versions are
immutable; never move or reuse a tag. Change bytes by publishing a higher SemVer. To
disable a compromised version, add its `kind/id@version` identity to
`registry/config.json`, bump the Registry sequence, and manually run the protected
Pages workflow. This changes catalog policy without replacing the old asset.

The Pages workflow aggregates entry documents from GitHub Releases and publishes
only valid entries. The production catalog is:

`https://microvoid.github.io/convax-plugins/registry/v1/index.json`
