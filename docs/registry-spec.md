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

Every item contains `kind`, `id`, `name`, `description`, `version`,
`compatibility`, `artifact`, and `yanked`, plus a complete `manifest` for Plugin items.
A `convax.plugin/2`, `convax.plugin/3`, `convax.plugin/4`, or `convax.plugin/5` item with a generation and/or service external runtime may additionally contain
`companions`; no other item may contain it.
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
complete validated manifest. Plugin compatibility accepts exactly one
version-matched pair: `convax.plugin/1` + `convax.plugin-host/1`,
`convax.plugin/2` + `convax.plugin-host/2`,
`convax.plugin/3` + `convax.plugin-host/3`,
`convax.plugin/4` + `convax.plugin-host/4`, or
`convax.plugin/5` + `convax.plugin-capability/1`. The embedded manifest schema must match
that pair. Crossed pairs and a v1 compatibility envelope around a v2 manifest are
rejected. Skill compatibility is exactly `{"skillSchema":"opencode.skill/1"}`.
Artifact objects contain only `url`, `size`, and lowercase hex `sha256`; URLs always
target `microvoid/convax-plugins` Release assets.

## Pet Plugins

A pet is a declarative `convax.plugin/5` capability published through the normal
Plugin Registry item. The complete embedded manifest contains
`contributes.pet` with `name`, `description`, package-relative `spritesheet`,
`spriteVersion: 2`, and `alt`. Pet-only Plugins have no `entry`, `runtime`, or
companion executable. The `convax.plugin-capability/1` compatibility label is a
transport-neutral admission contract; it is not a host-port version.

Clients validate the immutable artifact like every other Plugin, then validate the
sprite image before making it selectable. Installation does not imply waking the
pet. Convax—not the package—owns the desktop window, session activity, navigation,
state persistence, and removal behavior.

## Plugin-owned Skills

A Skill item may additionally contain `ownerPluginId`. This is lifecycle metadata
for Convax, not an Agent Skills field. The id must resolve to a Plugin item whose
`convax.plugin/4` or `convax.plugin/5` manifest contains a matching `contributes.skills` item. The
Registry is rejected if either side is missing.

Convax may show an owned Skill as a normal Skill detail with a “Provided by”
relationship, but install, update, and removal actions target the owner Plugin.
The Skill artifact remains a standard root-`SKILL.md` ZIP, so clients such as Codex
may still download and use it independently.

An owned Skill source change also changes the owner Plugin ZIP. Both package versions
must be bumped and released. Before Pages deployment, release coverage rebuilds every
source ZIP deterministically and compares its exact size and SHA-256 with the immutable
Release entry; a new Skill entry cannot be published beside stale owner Plugin bytes.

```json
{
  "kind": "skill",
  "id": "ffmpeg-canvas",
  "ownerPluginId": "ffmpeg-tools"
}
```

## Verified companion executables

An external v2, v3, v4, or v5 runtime is distributed beside, never inside, its static Plugin ZIP.
Its Plugin item has the following optional strict field:

```json
"companions": [{
  "command": "creative-tools-mcp",
  "version": "1.2.3",
  "targets": [{
    "platform": "darwin",
    "arch": "arm64",
    "artifact": {
      "url": "https://github.com/microvoid/convax-plugins/releases/download/plugin-creative-tools-v1.0.0/convax-companion-creative-tools-mcp-1.2.3-darwin-arm64",
      "size": 123456,
      "sha256": "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
    }
  }]
}]
```

`command` must match the manifest runtime command one-to-one. Companion commands
and each `platform`/`arch` target are unique. Platforms are `darwin`, `linux`, or
`win32`; architectures are `arm64` or `x64`. A binary is at most 128 MiB. Its URL
is not arbitrary: it must exactly equal the package's immutable Release tag plus
`convax-companion-<command>-<companion-version>-<platform>-<arch>` (`.exe` on
Windows). Clients select only their exact target, then verify byte count and SHA-256
before admitting the executable to host-owned storage. An absent target is an
unsupported platform, never permission to search `PATH` or download another URL.

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
