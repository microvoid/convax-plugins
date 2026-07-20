# Plugin authoring

A Convax Plugin package is inert, offline content. A Plugin with a Web surface is
served through a private protocol and mounted in an iframe with exactly
`sandbox="allow-scripts"`. It has an opaque origin: it cannot inspect the parent
DOM, use browser storage as shared application state, or access Node/Electron.

`convax.plugin/2` may instead be a headless executable Tool Plugin. Its ZIP still
contains no executable code: the manifest names a separately distributed bare
`mcp-stdio` command for generation and/or fixed service actions. The Registry may
bind that command to verified platform artifacts that Convax installs into
host-owned storage. Explicit Plugin install/update authorizes that exact binding;
later tool calls do not add another local-command prompt.

## Manifest

`package/manifest.json` uses either `convax.plugin/1` or `convax.plugin/2`. Only
documented fields are accepted. Source metadata must use the matching pair:

- `convax.plugin/1` with `convax.plugin-host/1`;
- `convax.plugin/2` with `convax.plugin-host/2`.

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
independent user action.

## Generation Tool Plugin

A headless v2 package declares `runtime` together with `contributes.generation`,
`contributes.service`, or both. It does not need an `entry`, `capabilities`, fake
HTML, Canvas renderer, provider field, model field, or credential field:

```json
{
  "schema": "convax.plugin/2",
  "id": "creative-tools",
  "name": "Creative Tools",
  "description": "Generates Canvas media through an external MCP tool.",
  "version": "1.0.0",
  "contributes": {
    "generation": {
      "tools": [{
        "id": "image.generate",
        "title": "Generate image",
        "description": "Generate an image from a prompt and optional visual references.",
        "output": "image",
        "acceptedInputs": ["reference_image"]
      }]
    }
  },
  "runtime": {
    "type": "mcp-stdio",
    "command": "creative-tools-mcp"
  }
}
```

Outputs are `text`, `image`, `video`, or `audio`. `acceptedInputs` may contain only
`reference_image`, `reference_video`, `first_frame`, `last_frame`, `audio`, and
`text`. It describes optional Canvas references; the prompt is always a separate
argument, so a prompt-only tool declares `[]`. Tool ids are unique within the
Plugin, and callers see `<plugin-id>/<tool-id>`.

`runtime.command` is a portable bare executable name, never a path. Optional args
are bounded static tokens without whitespace, shell syntax, native paths, or
traversal. Keep reviewed sidecar source under `tools/<id>` when it belongs in this
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

A v2 Web surface that calls installed generation tools requests
`generation.execute` and uses an ordinary `entry` plus Canvas contribution. It may
omit `runtime` and `contributes.generation`. Declaring a runtime does not grant the
Web surface caller authority, and granting `generation.execute` does not let the
iframe start processes or send arbitrary MCP requests.

## Plugin service contribution

A v2 executable Plugin may expose bounded account/service state through the same
verified sidecar process used by generation. The manifest declares only which
fixed host actions are meaningful; it cannot choose MCP method names or attach an
action payload:

```json
{
  "schema": "convax.plugin/2",
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

## Host connection

Convax transfers one fresh `MessagePort` to each mounted Plugin node. Accept it only
from `window.parent`, for the protocol matching the manifest (`/1` for v1 or `/2`
for v2), the exact Plugin id, and only once:

```js
const PROTOCOL = "convax.plugin-host/1"
window.addEventListener("message", function connect(event) {
  const message = event.data
  if (event.source !== window.parent || message?.protocol !== PROTOCOL ||
      message?.type !== "connect" || message?.pluginId !== "my-plugin" ||
      event.ports.length !== 1) return
  window.removeEventListener("message", connect)
  const port = event.ports[0]
  port.start()
})
```

Requests and responses use the transferred port, never global `postMessage`:

```json
{"protocol":"convax.plugin-host/1","type":"request","id":"1","method":"host.context.get"}
```

Responses repeat `protocol`, `type: "response"`, and `id`, with either
`{"ok":true,"result":...}` or `{"ok":false,"error":"..."}`. Toolbar commands
arrive as `{"protocol":"convax.plugin-host/1","type":"command","command":"refresh"}`.

## Capabilities

| Method | Manifest capability | Scope |
| --- | --- | --- |
| `host.context.get` | none | current Project, Canvas, and owning node |
| `canvas.node.get` | `canvas.node.read` | owning node only |
| `canvas.node.updateState` | `canvas.node.write` | Plugin-namespaced node state |
| `project.file.readText` | `project.files.read` | current Project-relative text file |
| `agent.prompt` | `agent.prompt` | current Project and owning node resource |
| `generation.tools.list` | `generation.execute` | installed generation contracts in the current scope |
| `generation.canvas.execute` | `generation.execute` | shared scoped Canvas generation operation |

Request the smallest set. Arguments cannot select another Project, Canvas, or node.
Treat results as untrusted structured data, bound message sizes, handle errors, and
render a useful disconnected state. A successful domain mutation may be followed by
a failed optional view effect; do not report that as a reverted mutation.

## Forbidden behavior

No remote scripts/assets, iframe network APIs, popups, downloads, eval-generated
code, native/WASM executables, packaged Node servers, filesystem paths, secrets,
telemetry, service workers, or generic method forwarding. Do not edit `.convax`
files. A v2 external runtime is a separately installed and authorized tool, never a
Plugin ZIP asset. Use host capabilities only.
