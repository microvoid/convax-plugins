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

The production builder reads historical Release entries but emits only the highest
stable SemVer for each kind/id; prereleases never replace a stable catalog item.
Packages are sorted by kind then id for deterministic output. Unknown fields are
rejected. Clients must ignore yanked items for new installs while still
allowing inventory/diagnostics for already-installed versions.
