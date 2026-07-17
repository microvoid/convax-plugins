# Plugin authoring

A Convax Plugin is an offline static Web surface. Convax installs its files, serves
them through a private protocol, and mounts its HTML entry in an iframe with exactly
`sandbox="allow-scripts"`. The Plugin has an opaque origin: it cannot inspect the
parent DOM, use browser storage as shared application state, or access Node/Electron.

## Manifest

`package/manifest.json` uses `convax.plugin/1`. Only documented fields are accepted.

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

## Host connection

Convax transfers one fresh `MessagePort` to each mounted Plugin node. Accept it only
from `window.parent`, for the exact protocol and Plugin id, and only once:

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

Request the smallest set. Arguments cannot select another Project, Canvas, or node.
Treat results as untrusted structured data, bound message sizes, handle errors, and
render a useful disconnected state. A successful domain mutation may be followed by
a failed optional view effect; do not report that as a reverted mutation.

## Forbidden behavior

No remote scripts/assets, network APIs, popups, downloads, eval-generated code,
native/WASM executables, filesystem paths, secrets, telemetry, service workers, or
generic method forwarding. Do not edit `.convax` files. Use host capabilities only.
