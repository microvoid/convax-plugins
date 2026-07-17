# Registry contract (`convax.registry/1`)

The Registry is metadata, not an execution endpoint. Convax fetches it from the
fixed Microvoid Pages URL, selects a compatible item, downloads the fixed HTTPS
Release URL, checks byte size and SHA-256, then revalidates the unpacked package with
its existing local installer.

Top-level fields are exactly `schema`, `sequence`, `revision`, and `packages`.
`sequence` is a monotonically increasing positive integer used to reject rollback.
It is source-controlled in `registry/config.json` and must increase before each
catalog-changing release or yanking deployment. `revision` is the lowercase, full
40-character Git commit SHA used to build the catalog.

Every item contains exactly `kind`, `id`, `name`, `description`, `version`,
`compatibility`, `artifact`, `yanked`, plus a complete `manifest` for Plugin items.
The duplicated Plugin identity fields must equal the manifest so the management UI
can render and filter without downloading ZIPs. Skill items have no `manifest`.

```json
{
  "schema": "convax.registry/1",
  "sequence": 1,
  "revision": "0123456789abcdef0123456789abcdef01234567",
  "packages": [{
    "kind": "plugin",
    "id": "hello-convax",
    "name": "Hello Convax",
    "description": "Checks the scoped Convax Plugin host connection.",
    "version": "0.1.0",
    "compatibility": {
      "pluginSchema": "convax.plugin/1",
      "pluginHost": "convax.plugin-host/1"
    },
    "artifact": {
      "url": "https://github.com/microvoid/convax-plugins/releases/download/plugin-hello-convax-v0.1.0/convax-plugin-hello-convax-0.1.0.zip",
      "size": 1234,
      "sha256": "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
    },
    "yanked": false,
    "manifest": { "schema": "convax.plugin/1", "id": "hello-convax" }
  }]
}
```

The abbreviated manifest above is explanatory only; production entries contain the
complete validated manifest. Plugin compatibility is exactly
`convax.plugin/1` + `convax.plugin-host/1`. Skill compatibility is exactly
`{"skillSchema":"opencode.skill/1"}`. Artifact objects contain only `url`,
`size`, and lowercase hex `sha256`; URLs always target
`microvoid/convax-plugins` Release assets.

`opencode.skill/1` is the retained Registry v1 compatibility label used by current
Convax clients; it is not the bundle format. Published Skill ZIPs follow the open
Agent Skills `SKILL.md` layout and may include client-specific metadata such as
`agents/openai.yaml`. Renaming this strict field requires a future Registry
version so older clients do not reject an otherwise valid catalog.

The production builder reads historical Release entries but emits only the highest
stable SemVer for each kind/id; prereleases never replace a stable catalog item.
Packages are sorted by kind then id for deterministic output. Unknown fields are
rejected. Clients must ignore yanked items for new installs while still
allowing inventory/diagnostics for already-installed versions.

## Showcase sidecar (`convax.showcase/1`)

Presentation media is published separately at
`https://microvoid.github.io/convax-plugins/showcase/v1/index.json`. It never adds
fields to strict Registry v1 items and never enters a package ZIP. The top-level
`sequence` and `revision` must exactly match the Registry fetched by the client;
otherwise the whole sidecar is ignored.

Each sidecar item identifies the same `kind`, `id`, and `version` as a current
Registry package and contains a required `poster` plus an optional `animation`.
Media objects contain exactly `url`, `mime`, `size`, `sha256`, `width`, `height`,
and `alt`. URLs target immutable assets on that package's own GitHub Release.
Clients verify identity, URL, MIME, byte count, digest, and file signature before
rendering media. A missing or invalid sidecar degrades to an unanimated catalog;
it must not prevent listing or installing packages.
