# Plugin authoring

A Convax Plugin package is inert, offline content. A Plugin with a Web surface is
served through a private protocol and mounted in an iframe with exactly
`sandbox="allow-scripts"`. It has an opaque origin: it cannot inspect the parent
DOM, use browser storage as shared application state, or access Node/Electron.

`convax.plugin/2` through `convax.plugin/5` may instead be headless
executable Tool Plugins. New executable Plugins should use v3, or v4 when they own
Skills; use v5 for transport-neutral capabilities such as an LLM provider or Pet
feature. Their ZIP still contains no executable code: the manifest names a separately distributed bare
`mcp-stdio` command for generation and/or fixed service actions. The Registry may
bind that command to verified platform artifacts that Convax installs into
host-owned storage. Explicit Plugin install/update authorizes that exact binding;
later tool calls do not add another local-command prompt.

## Manifest

`package/manifest.json` uses `convax.plugin/1`, `convax.plugin/2`,
`convax.plugin/3`, `convax.plugin/4`, or `convax.plugin/5`. Only
documented fields are accepted. Source metadata must use the matching pair:

- `convax.plugin/1` with `convax.plugin-host/1`;
- `convax.plugin/2` with `convax.plugin-host/2`;
- `convax.plugin/3` with `convax.plugin-host/3`;
- `convax.plugin/4` with `convax.plugin-host/4`;
- `convax.plugin/5` with `convax.plugin-capability/1`.

The v1 schema is static-only:

```json
{
  "schema": "convax.plugin/1",
  "id": "my-plugin",
  "name": "My Plugin",
  "description": "A focused Canvas surface.",
  "version": "0.1.0",
  "entry": "index.html",
  "capabilities": ["canvas.node.read"],
  "contributes": {
    "canvas": {
      "renderer": { "create": true, "width": 640, "height": 400 },
      "toolbar": [{ "id": "refresh", "title": "Refresh", "command": "refresh" }]
    }
  }
}
```

Renderer matching may use `create`, `extensions`, `mimeTypes`, or `nodeKinds`.
Package paths are POSIX-relative and case-sensitive. The optional `skill` points to
a companion `SKILL.md` inside the same Plugin ZIP; installing it remains an explicit,
independent user action. This legacy field is available only through v3. Do not use
it for a Skill whose lifecycle belongs to its Plugin.

## Pet contribution

`convax.plugin/5` adds a sandboxed Pet feature contribution. A package contributes
one Pet feature Plugin and
owns its static overlay, settings, packaged collection, animation rules, and
selection. Its `convax.plugin-capability/1` compatibility label describes manifest
support; the surfaces use the separate `convax.pet-host/1` protocol:

The `contributes.pet` object declares the library and both static feature surfaces:

```json
{
  "schema": "convax.plugin/5",
  "id": "convax-pet",
  "name": "Convax Pet",
  "description": "A local desktop companion and pet library for Convax activity.",
  "version": "0.2.1",
  "capabilities": [
    "pet.activity.read",
    "pet.activity.open",
    "pet.preferences.write",
    "pet.custom.manage"
  ],
  "contributes": {
    "pet": {
      "library": "pet-library.json",
      "overlay": "pet/index.html",
      "settings": "settings/index.html",
      "protocol": "convax.pet-host/1"
    }
  }
}
```

The `convax.pet-library/1` document contains one to 64 unique pet entries. Each
entry supplies `id`, `displayName`, `description`, package-relative `spritesheet`,
`spriteVersion: 2`, and `alt`. Every atlas is a 1536×1872 PNG or WebP containing
eight 192×208 cells across and nine state rows in this order: `idle`,
`running-right`, `running-left`, `waving`, `jumping`, `failed`, `waiting`,
`running`, and `review`.

The exact `pet.custom.manage` grant exposes only the scoped
`collection.get`/`collection.import`/`collection.delete` host methods. Import uses
the native Convax file picker; a Pet surface never receives a filesystem path.
Convax accepts one current-format transparent 1536×1872 PNG or WebP atlas, stores a
managed copy, and serves it through `convax-pet-asset:`. Legacy Goku folders,
`pet.json`, remote assets, and arbitrary file reads are not supported.

The settings and overlay pages run with no Node, Electron, remote network, native
path, or arbitrary IPC access. Their surface-scoped `convax.pet-host/1` ports expose
only content-free activity, validated navigation, overlay movement, preferences,
and wake/tuck lifecycle. Installation never wakes the pet automatically. New pets
ship as library entries in a new version of the same feature Plugin.

## Plugin-owned Skills

`convax.plugin/4` and `convax.plugin/5` replace the ambiguous singular `skill` field with explicit
Plugin-owned Skill contributions. The owner must still provide a real Plugin
capability—such as a sandboxed Canvas renderer, an executable generation/service
runtime, or a renderer-mediated generation action—beyond merely wrapping a Skill:

```json
{
  "schema": "convax.plugin/4",
  "id": "creative-tools",
  "name": "Creative Tools",
  "description": "Provides local creative operations and their Agent workflow.",
  "version": "1.0.0",
  "contributes": {
    "generation": {
      "models": [],
      "tools": [
        {
          "id": "media.inspect",
          "title": "Inspect media",
          "description": "Inspect one staged media input.",
          "output": "text",
          "acceptedInputs": ["reference_video"]
        }
      ]
    },
    "skills": [
      {
        "name": "creative-tools-workflow",
        "path": "skills/creative-tools-workflow"
      }
    ]
  },
  "runtime": { "type": "mcp-stdio", "command": "creative-tools-mcp" }
}
```

Each `name` is a portable Skill id and each path is exactly `skills/<name>`.
The Skill is authored once under `packages/skills/<name>/package/`; do not copy it
into the Plugin source. The Skill source metadata declares `ownerPluginId`, and the
packer injects its files into the Plugin ZIP after validating both declarations.
Any owned Skill byte change also changes the Plugin ZIP, so publish a new owner
Plugin version together with the new Skill version; release coverage rejects stale
same-version owner bytes.

Convax may list the Skill with a “Provided by” relationship, but users install,
update, and remove it only through the owning Plugin. Its standard standalone ZIP
remains usable by Codex and other Agent Skills clients. A normal standalone Skill
that merely benefits from an optional Plugin must omit `ownerPluginId` and provide
an honest missing-tool fallback instead.

## Declarative Tool Plugin

A headless v3 or v4 package declares `runtime` together with `contributes.generation`,
`contributes.service`, or both. It does not need an `entry`, `capabilities`, fake
HTML, Canvas renderer, provider field, or credential field. The execution catalog
and model catalog are deliberately separate:

```json
{
  "schema": "convax.plugin/3",
  "id": "creative-tools",
  "name": "Creative Tools",
  "description": "Generates Canvas media through an external MCP tool.",
  "version": "1.0.0",
  "contributes": {
    "generation": {
      "models": [{ "tool": "image.generate", "name": "Imagine Pro" }],
      "tools": [
        {
          "id": "image.generate",
          "title": "Generate image",
          "description": "Generate an image from a prompt and optional visual references.",
          "output": "image",
          "acceptedInputs": ["reference_image"]
        }
      ]
    }
  },
  "runtime": {
    "type": "mcp-stdio",
    "command": "creative-tools-mcp"
  }
}
```

`generation.tools` is the complete executable MCP tool contract.
`generation.models` is required in v3 and is the only source for the model picker;
it contains `{tool,name}` references to generation tools and may be `[]` for an
operation-only Plugin such as FFmpeg. Model names and referenced tools are unique.
This positive declaration prevents utilities from appearing as generation models.

Outputs are `text`, `image`, `video`, or `audio`. `acceptedInputs` may contain only
`reference_image`, `reference_video`, `first_frame`, `last_frame`, `audio`, and
`text`. It describes optional Canvas references; the prompt is always a separate
argument, so a prompt-only tool declares `[]`. Tool ids are unique within the
Plugin, and execution callers see `<plugin-id>/<tool-id>`.

v3 may expose selected non-model tools to the Agent with
`contributes.agent.tools`. Each item has a stable Agent id matching
`^[a-z][a-z0-9_]{0,63}$` and a `tool` reference. At most 32 are allowed; ids and
tool references are unique, and model tools cannot also be Agent tools. Hosts
derive the public name generically from the Plugin and Agent ids, for example
`plugin_ffmpeg_tools_run_video`. MCP clients may add their server namespace, such
as `convax_plugin_ffmpeg_tools_run_video`. A Plugin id never creates a host special
case.

Video-node actions are declared under `contributes.canvas.selectionActions`.
Each action supplies localized `title` and `description`, `target: "video"`, one
of the fixed editors (`time-point`, `time-range`, `crop-region`, or
`confirmation`), and up to 16 ordered `{tool}` steps. Interactive editors require
exactly one step. Every step must reference a non-model tool whose
`acceptedInputs` includes `reference_video`. A confirmation action may declare
multiple steps, which supports paired outputs such as video-only plus audio-only.
`canvas.renderer` is optional; toolbar contributions remain renderer-only.

`runtime.command` is a portable bare executable name, never a path. Optional args
are bounded static tokens without whitespace, shell syntax, native paths, or
traversal. Keep reviewed sidecar source under `packages/tools/<id>` when it belongs in this
repository, distribute it separately, and keep the executable and dependency tree
out of `package/`. A first-party package declares its reviewed `source`, companion
version, and platform targets in the adjacent `convax-package.json`; publishing
turns those build paths into immutable Registry URLs with byte size and SHA-256.
Convax installs only an exact platform/architecture target and fingerprints it.
Explicitly installing or updating the Tool Plugin is consent to run that exact
manifest/executable binding; normal generation and service calls do not add a
first-call or per-billable-call command prompt. Missing or changed bytes fail
closed and require reinstall. The Plugin manifest never contains build paths,
vendor credentials, or a fallback download URL, and the user does not need to copy
the executable into `PATH`.

A v2 through v5 Web surface that calls installed generation tools requests
`generation.execute` and uses an ordinary `entry` plus Canvas contribution. It may
omit `runtime` and `contributes.generation`. Declaring a runtime does not grant the
Web surface caller authority, and granting `generation.execute` does not let the
iframe start processes or send arbitrary MCP requests.

## Plugin service contribution

A v2 through v5 executable Plugin may expose bounded account/service state through the same
verified sidecar process used by generation. The manifest declares only which
fixed host actions are meaningful; it cannot choose MCP method names or attach an
action payload:

```json
{
  "schema": "convax.plugin/3",
  "id": "account-tools",
  "name": "Account Tools",
  "description": "Shows bounded account status from an external tool.",
  "version": "1.0.0",
  "contributes": {
    "service": { "actions": ["sign_out"] }
  },
  "runtime": {
    "type": "mcp-stdio",
    "command": "account-tools-mcp"
  }
}
```

`actions` is a unique subset of `authorize`, `reauthorize`,
`authorization.cancel`, and `sign_out`; an empty array declares status-only UI.
The sidecar must always expose `service.status`, plus the corresponding fixed MCP
tool for every declared action (`service.authorize`, `service.reauthorize`,
`service.authorization.cancel`, or `service.sign_out`). Every tool accepts exactly
an empty object.

Successful service tools return `structuredContent` with exactly the
`convax.plugin-service-status/1` display contract: `schema`, `state`, `credential`,
`account`, `credits`, and `usage`. Do not return credentials, URLs, native paths,
cookies, arbitrary diagnostics, or provider configuration. Unsupported account,
credit, or usage APIs must be represented as `{ "availability": "unavailable" }`,
not guessed values. Declaring an action does not grant browser, Cookie, or generic
network access; the separately reviewed sidecar remains responsible for its own
documented API boundary.

If a reviewed sidecar must retain a higher-privilege first-party Web session for
live service metadata, say so in the installed Plugin description. Store it
separately from generation credentials in atomic Plugin-private storage, bind it
to the matching authorization generation, never return it through MCP, and clear
it on sign-out. Mode `0600` is best-effort isolation from other OS users; it does
not protect against processes already running as the same OS account.

## LLM provider contribution

`convax.plugin/5` may contribute one OpenAI-compatible provider through the same
verified sidecar lifecycle. The manifest contains display and selection metadata
only:

```json
{
  "contributes": {
    "llm": {
      "provider": { "id": "example-llm", "name": "Example LLM" },
      "models": [{ "id": "example-main", "name": "Example Main" }]
    }
  }
}
```

The sidecar must expose the fixed, empty-input MCP tool `llm.gateway.start`. Its
Main-only `structuredContent` is exactly `{schema, base_url, api_key}` with schema
`convax.llm-gateway/1`, an ephemeral `http://127.0.0.1:<port>/v1` URL, and a random
process-lifetime key. The gateway accepts only authenticated OpenAI-compatible
requests for declared models. It owns upstream URLs, headers, credentials, Cookies,
streaming, cancellation, and vendor error adaptation; none of those values belongs
in the manifest, renderer, service status, or durable OpenCode config.

Hosts namespace provider ids by Plugin identity, verify the installed executable
before starting it, and discard the gateway when that exact Plugin runtime changes.
An unavailable or invalid gateway is omitted rather than weakening loopback or
executable verification.

The v5 compatibility pair deliberately uses the independently versioned
`convax.plugin-capability/1` broker. It does not extend the legacy iframe
`convax.plugin-host/N` sequence.

## Host connection

Convax transfers one fresh `MessagePort` to each mounted Plugin node using the
versioned `convax.plugin-host/1` through `/4` protocols. Accept it only from
`window.parent`, for the host protocol matching the manifest major, the exact
Plugin id, and only once. The transport-neutral v5 compatibility label does not by
itself grant this Canvas port. A Pet feature provider instead receives a separate
`convax.pet-host/1` port only on its declared overlay and settings surfaces:

```js
const PROTOCOL = "convax.plugin-host/1";
window.addEventListener("message", function connect(event) {
  const message = event.data;
  if (
    event.source !== window.parent ||
    message?.protocol !== PROTOCOL ||
    message?.type !== "connect" ||
    message?.pluginId !== "my-plugin" ||
    event.ports.length !== 1
  )
    return;
  window.removeEventListener("message", connect);
  const port = event.ports[0];
  port.start();
});
```

Requests and responses use the transferred port, never global `postMessage`:

```json
{
  "protocol": "convax.plugin-host/1",
  "type": "request",
  "id": "1",
  "method": "host.context.get"
}
```

Responses repeat `protocol`, `type: "response"`, and `id`, with either
`{"ok":true,"result":...}` or `{"ok":false,"error":"..."}`. Toolbar commands
arrive as `{"protocol":"convax.plugin-host/1","type":"command","command":"refresh"}`.

## Capabilities

| Method                        | Manifest capability           | Scope                                                        |
| ----------------------------- | ----------------------------- | ------------------------------------------------------------ |
| `host.context.get`            | none                          | current Project, Canvas, and owning node                     |
| `canvas.node.get`             | `canvas.node.read`            | owning node only                                             |
| `canvas.node.updateState`     | `canvas.node.write`           | Plugin-namespaced node state                                 |
| `canvas.connectedImages.list` | `canvas.connectedImages.read` | directly connected managed Canvas image nodes                |
| `canvas.connectedImages.read` | `canvas.connectedImages.read` | bounded bytes for one directly connected managed image       |
| `canvas.image.create`         | `canvas.image.write`          | one bounded PNG imported as a managed adjacent Canvas image  |
| `project.file.readText`       | `project.files.read`          | current Project-relative text file                           |
| `agent.prompt`                | `agent.prompt`                | current Project and owning node resource                     |
| `generation.tools.list`       | `generation.execute`          | installed generation contracts in the current scope          |
| `generation.canvas.execute`   | `generation.execute`          | shared scoped Canvas generation operation                    |

Request the smallest set. Arguments cannot select another Project, Canvas, or node.
Treat results as untrusted structured data, bound message sizes, handle errors, and
render a useful disconnected state. A successful domain mutation may be followed by
a failed optional view effect; do not report that as a reverted mutation.
`canvas.image.create` accepts a bounded PNG data URL and a portable display name;
the host owns asset admission, node placement, the connection from the Plugin node,
persistence, and rollback if the Canvas commit fails.
The canonical production example is
[`panorama-viewer`](../packages/plugins/panorama-viewer); its complete Web surface
and manifest live in this repository, while Convax Desktop owns only these generic
host operations.

## Forbidden behavior

No remote scripts/assets, iframe network APIs, popups, downloads, eval-generated
code, native/WASM executables, packaged Node servers, filesystem paths, secrets,
telemetry, service workers, or generic method forwarding. Do not edit `.convax`
files. A v2, v3, v4, or v5 external runtime is a separately installed and authorized tool, never a
Plugin ZIP asset. Use host capabilities only.
