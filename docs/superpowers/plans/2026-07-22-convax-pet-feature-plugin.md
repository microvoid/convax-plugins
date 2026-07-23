# Convax Pet Feature Plugin Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Refactor the pet prototype into one sandboxed Convax Pet feature Plugin that owns Violet, its packaged library, overlay UI, settings UI, animation rules, and selection while Convax retains only generic native and security-sensitive host primitives.

**Architecture:** `convax.plugin/5` declares one singleton Pet provider with package-relative `library`, `overlay`, and `settings` entries and a `convax.pet-host/1` protocol. Static Plugin JavaScript renders both surfaces and consumes narrow host APIs; Convax validates the package, mounts the surfaces, projects content-free activity, resolves navigation, controls the native window, and stores bounded preferences. No legacy pet, Goku, directory, `pet.json`, or raw spritesheet import remains.

**Tech Stack:** Bun 1.3, ECMAScript modules, JSON Schema, TypeScript, React 19 for the Convax settings host, Electron BrowserWindow/session/protocol APIs, existing Convax plugin asset protocol and test infrastructure.

---

## File ownership map

### `convax-plugins`

- `schemas/convax-plugin-manifest-v5.schema.json`: strict feature contribution and Pet capabilities.
- `tooling/lib.mjs`: parser plus package-library and atlas validation.
- `tooling/plugin-v5.test.js`: schema/parser/package byte coverage.
- `packages/plugins/convax-pet/package/manifest.json`: feature entry points and capabilities.
- `packages/plugins/convax-pet/package/pet-library.json`: immutable `convax.pet-library/1` catalog.
- `packages/plugins/convax-pet/package/assets/pet-library.js`: browser-consumable catalog matching the JSON source.
- `packages/plugins/convax-pet/package/assets/activity.js`: activity priority and animation rules.
- `packages/plugins/convax-pet/package/assets/pet-host.js`: bounded MessagePort client.
- `packages/plugins/convax-pet/package/pet/*`: Plugin-owned overlay surface.
- `packages/plugins/convax-pet/package/settings/*`: Plugin-owned settings surface.
- `packages/plugins/convax-pet/*.test.js`: pure library, activity, protocol, and static-surface tests.
- `README.md`, `README.zh-CN.md`, `docs/plugin-authoring.md`, `docs/packaging.md`, `docs/registry-spec.md`: revised feature Plugin documentation.
- `registry/config.json`: publication sequence bump.

### `/Users/bytedance/src/convax`

- `packages/desktop/src/plugin-contracts.ts`: host mirror of the strict contribution.
- `packages/desktop/src/plugin-contracts.test.ts`: parser regression coverage.
- `packages/desktop/src/main/plugin-manager.ts`: entry/library/atlas install validation.
- `packages/desktop/src/main/plugin-manager.test.ts`: real package validation tests.
- `packages/desktop/src/pet-contracts.ts`: `convax.pet-host/1` request/event and provider snapshots.
- `packages/desktop/src/main/pet-provider-controller.ts`: singleton provider and wake lifecycle.
- `packages/desktop/src/main/pet-host-connection.ts`: per-surface allowlists and dispatch.
- `packages/desktop/src/main/pet-state-store.ts`: provider, window, acknowledgement, and bounded Plugin preference state.
- `packages/desktop/src/main/pet-window.ts`: loads the installed overlay entry instead of host UI.
- `packages/desktop/src/main/pet-session.ts`: registers installed Plugin assets on the isolated overlay session.
- `packages/desktop/src/main/pet-ipc.ts`: trusted renderer/overlay bridge without raw import.
- `packages/desktop/src/preload/pet.ts`: fixed top-level overlay connector.
- `packages/desktop/src/preload/index.ts`: settings-host bridge.
- `packages/desktop/src/renderer/pet-settings-host.tsx`: sandboxed settings iframe and port relay.
- `packages/desktop/src/renderer/settings-view.tsx`: conditionally mounts the provider surface.
- `packages/desktop/src/main/index.ts` and `application-lifecycle.ts`: compose and dispose the provider.
- `packages/desktop/electron.vite.config.ts`: stop bundling host-owned pet renderer; retain the fixed preload.
- Existing `agent-activity-controller.ts`: retained as the content-free host projection.
- Existing host-owned `renderer/pet/*`, `renderer/pet-settings.tsx`, custom-pet branches in `pet-controller.ts`, and `convax-pet-asset` protocol: removed after replacement tests are green.

---

### Task 1: Replace the repository Pet manifest contract

**Files:**
- Modify: `schemas/convax-plugin-manifest-v5.schema.json`
- Modify: `tooling/lib.mjs`
- Modify: `tooling/plugin-v5.test.js`

- [ ] **Step 1: Write failing feature-contribution parser tests**

Replace the test Pet fixture with:

```js
function petManifest(overrides = {}) {
  return {
    schema: "convax.plugin/5",
    id: "convax-pet",
    name: "Convax Pet",
    description: "A local desktop companion and pet library.",
    version: "0.2.0",
    capabilities: ["pet.activity.read", "pet.activity.open", "pet.preferences.write"],
    contributes: {
      pet: {
        library: "pet-library.json",
        overlay: "pet/index.html",
        settings: "settings/index.html",
        protocol: "convax.pet-host/1",
      },
    },
    ...overrides,
  }
}
```

Assert exact parsed output, HTML extensions for both entries, JSON extension for
the library, fixed protocol, exact required Pet capabilities, rejection of the
old `spritesheet` shape, unknown fields, traversal, URLs, duplicate capabilities,
runtime declarations, and `convax.plugin/1` through `/4`.

- [ ] **Step 2: Run the focused tests and confirm RED**

Run:

```sh
bun test tooling/plugin-v5.test.js
```

Expected: failures because `parsePetV5` still requires one spritesheet and the
Pet capability strings are not admitted.

- [ ] **Step 3: Implement the strict schema and parser**

Change the Pet schema to:

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": ["library", "overlay", "settings", "protocol"],
  "properties": {
    "library": { "allOf": [{ "$ref": "./convax-plugin-manifest-v4.schema.json#/$defs/path" }, { "pattern": "\\.json$" }] },
    "overlay": { "allOf": [{ "$ref": "./convax-plugin-manifest-v4.schema.json#/$defs/path" }, { "pattern": "\\.html$" }] },
    "settings": { "allOf": [{ "$ref": "./convax-plugin-manifest-v4.schema.json#/$defs/path" }, { "pattern": "\\.html$" }] },
    "protocol": { "const": "convax.pet-host/1" }
  }
}
```

Add the three Pet capability strings to the v5 capability set. Parse the four
exact fields with `parseRelativePath`, enforce extensions and protocol, and require
the exact three capabilities whenever `contributes.pet` is present. Reject a Pet
contribution combined with `runtime`.

- [ ] **Step 4: Run the focused tests and confirm GREEN**

Run `bun test tooling/plugin-v5.test.js`.

Expected: all v5 tests pass, including unrelated Project/Canvas/LLM fixtures.

- [ ] **Step 5: Commit the contract**

```sh
git add schemas/convax-plugin-manifest-v5.schema.json tooling/lib.mjs tooling/plugin-v5.test.js
git commit -m "feat(plugin): define pet feature surfaces"
```

### Task 2: Validate packaged pet libraries and every atlas

**Files:**
- Modify: `tooling/lib.mjs`
- Modify: `tooling/plugin-v5.test.js`

- [ ] **Step 1: Add failing package-library tests**

Cover this exact library:

```json
{
  "schema": "convax.pet-library/1",
  "pets": [{
    "id": "violet",
    "displayName": "Violet",
    "description": "A pixel companion for Convax.",
    "spritesheet": "assets/violet.webp",
    "spriteVersion": 2,
    "alt": "Violet, the Convax pixel companion"
  }]
}
```

Test missing library, invalid UTF-8/JSON, unknown fields, empty pets, duplicate ID,
unsafe atlas path, missing atlas, extension/signature mismatch, wrong dimensions,
and valid PNG/WebP libraries with multiple pets.

- [ ] **Step 2: Confirm RED**

Run `bun test tooling/plugin-v5.test.js`.

Expected: package validation still looks for `manifest.contributes.pet.spritesheet`.

- [ ] **Step 3: Implement `validatePetPackageLibrary`**

The function must find the declared library file in inert package entries, parse
strict UTF-8 JSON, validate the exact schema, deduplicate IDs and paths, and call
the existing image-dimension/signature inspector for each referenced atlas. Return
a cloned bounded library object; never execute package content.

Wire it into package discovery in place of `validatePetPackageAsset`.

- [ ] **Step 4: Confirm GREEN**

Run `bun test tooling/plugin-v5.test.js`.

Expected: all library and atlas cases pass.

- [ ] **Step 5: Commit library validation**

```sh
git add tooling/lib.mjs tooling/plugin-v5.test.js
git commit -m "feat(plugin): validate packaged pet libraries"
```

### Task 3: Add the Plugin-owned library and activity model

**Files:**
- Create: `packages/plugins/convax-pet/package/pet-library.json`
- Create: `packages/plugins/convax-pet/package/assets/pet-library.js`
- Create: `packages/plugins/convax-pet/package/assets/activity.js`
- Create: `packages/plugins/convax-pet/pet-library.test.js`
- Create: `packages/plugins/convax-pet/activity.test.js`
- Modify: `packages/plugins/convax-pet/package.json`

- [ ] **Step 1: Write failing pure-module tests**

Test that the browser library exactly matches `pet-library.json`, resolves
`violet`, falls back to `violet` for an absent selection, and does not expose a
mutable shared object. Test exact activity priority and mappings:

```js
export const priority = { "needs-input": 0, blocked: 1, ready: 2, running: 3 }
export function animationFor(activity) {
  if (!activity) return "idle"
  if (activity.state === "needs-input") return activity.subtype === "permission" ? "review" : "waiting"
  if (activity.state === "blocked") return "failed"
  if (activity.state === "ready") return "waving"
  return "running"
}
```

- [ ] **Step 2: Confirm RED**

Run `bun test packages/plugins/convax-pet/pet-library.test.js packages/plugins/convax-pet/activity.test.js`.

Expected: modules are missing.

- [ ] **Step 3: Implement immutable packaged data and pure rules**

Add Violet to both representations. Export `petLibrary`, `selectedPet`,
`orderedActivities`, `animationFor`, the nine animation definitions, and bounded
status copy. Freeze exported data and return clones at state boundaries.

Add `"test": "bun test"` to the workspace scripts.

- [ ] **Step 4: Confirm GREEN**

Run the same focused tests.

Expected: all library and activity tests pass.

- [ ] **Step 5: Commit Plugin product data**

```sh
git add packages/plugins/convax-pet
git commit -m "feat(plugin): add packaged pet library"
```

### Task 4: Implement the bounded Pet host client

**Files:**
- Create: `packages/plugins/convax-pet/package/assets/pet-host.js`
- Create: `packages/plugins/convax-pet/pet-host.test.js`

- [ ] **Step 1: Write failing protocol-client tests**

Use fake `window` and `MessagePort` objects to verify that the client accepts one
connection only when `event.source` is the expected parent/window, the protocol is
`convax.pet-host/1`, the surface and Plugin ID match, and exactly one port exists.
Verify request IDs, response matching, event delivery, disconnect rejection, and
the 64-pending-request bound.

- [ ] **Step 2: Confirm RED**

Run `bun test packages/plugins/convax-pet/pet-host.test.js`.

Expected: the client module is missing.

- [ ] **Step 3: Implement the client**

Export `connectPetHost({ pluginId, surface, source })`. The returned API must expose
only `request(method, params)`, `subscribe(event, listener)`, and `close()`. It must
validate envelopes, cap string/error sizes, remove listeners on close, and never
use global `postMessage` after accepting the transferred port.

- [ ] **Step 4: Confirm GREEN and commit**

Run the focused test, then:

```sh
git add packages/plugins/convax-pet/package/assets/pet-host.js packages/plugins/convax-pet/pet-host.test.js
git commit -m "feat(plugin): add scoped pet host client"
```

### Task 5: Move the overlay UI into the Plugin

**Files:**
- Create: `packages/plugins/convax-pet/package/pet/index.html`
- Create: `packages/plugins/convax-pet/package/pet/app.js`
- Create: `packages/plugins/convax-pet/package/pet/styles.css`
- Create: `packages/plugins/convax-pet/overlay.test.js`

- [ ] **Step 1: Write failing overlay behavior tests**

Extract and test pure helpers for frame selection, reduced motion, drag threshold,
keyboard actions, status copy, visible activities, and navigation sequencing.
Assert that the HTML loads only local CSS/modules and contains no inline script,
remote URL, form, webview, or Node/Electron reference.

- [ ] **Step 2: Confirm RED**

Run `bun test packages/plugins/convax-pet/overlay.test.js`.

Expected: Plugin overlay files are missing.

- [ ] **Step 3: Implement the Plugin overlay**

Port the existing Convax layout and styling into static DOM code. Read the selected
pet from the packaged library and preferences supplied by the host. Subscribe to
`activity.changed`, render a collapsed 176×176 surface or a 356×320 tray, use the
8×9 atlas, request `overlay.move`, `overlay.setExpanded`, and `activity.open`, and
create no animation timer when `matchMedia('(prefers-reduced-motion: reduce)')`
matches.

- [ ] **Step 4: Confirm GREEN and commit**

Run the focused Plugin tests, then:

```sh
git add packages/plugins/convax-pet/package/pet packages/plugins/convax-pet/overlay.test.js
git commit -m "feat(plugin): own floating pet surface"
```

### Task 6: Move the settings and collection UI into the Plugin

**Files:**
- Create: `packages/plugins/convax-pet/package/settings/index.html`
- Create: `packages/plugins/convax-pet/package/settings/app.js`
- Create: `packages/plugins/convax-pet/package/settings/styles.css`
- Create: `packages/plugins/convax-pet/settings.test.js`

- [ ] **Step 1: Write failing settings tests**

Test rendering every packaged library item, selected state, selection without
implicit wake, explicit wake/tuck, fallback to Violet for stale preferences, and a
disconnected error state. Assert there is no import, upload, delete, URL, or file
input control.

- [ ] **Step 2: Confirm RED**

Run `bun test packages/plugins/convax-pet/settings.test.js`.

Expected: Plugin settings files are missing.

- [ ] **Step 3: Implement the settings surface**

Render Convax-aligned cards using package assets. Use only
`preferences.get`, `preferences.update`, and `lifecycle.setAwake`. Selection writes
`{ selectedPetId }`; wake remains a separate explicit action. Keep all user-facing
pet copy inside the Plugin bundle.

- [ ] **Step 4: Confirm GREEN and commit**

Run the focused tests, then:

```sh
git add packages/plugins/convax-pet/package/settings packages/plugins/convax-pet/settings.test.js
git commit -m "feat(plugin): own pet collection settings"
```

### Task 7: Publish the revised Plugin package contract

**Files:**
- Modify: `packages/plugins/convax-pet/package/manifest.json`
- Modify: `packages/plugins/convax-pet/package/README.md`
- Modify: `packages/plugins/convax-pet/package.json`
- Modify: `packages/plugins/convax-pet/convax-package.json`
- Modify: `README.md`
- Modify: `README.zh-CN.md`
- Modify: `docs/plugin-authoring.md`
- Modify: `docs/packaging.md`
- Modify: `docs/registry-spec.md`
- Modify: `registry/config.json`
- Modify: `tooling/workspaces.test.js`
- Modify: `tooling/registry.test.js`

- [ ] **Step 1: Write failing documentation/metadata assertions**

Require version `0.2.0`, the three exact capabilities, four contribution fields,
the feature-Plugin ownership wording, packaged library documentation, and absence
of “pet-only inert sprite contribution” wording.

- [ ] **Step 2: Confirm RED**

Run:

```sh
bun test tooling/workspaces.test.js tooling/registry.test.js tooling/plugin-v5.test.js
```

- [ ] **Step 3: Update package, docs, and catalog metadata**

Set both package versions to `0.2.0`, point the manifest at
`pet-library.json`, `pet/index.html`, and `settings/index.html`, retain
`convax.plugin-capability/1` source compatibility, and increment the Registry
sequence exactly once. Document that future pets are bundled into the same Plugin.

- [ ] **Step 4: Verify and commit the Plugin repository**

Run:

```sh
bun run validate -- --kind plugin --id convax-pet
bun test packages/plugins/convax-pet tooling/plugin-v5.test.js tooling/workspaces.test.js tooling/registry.test.js
bun run pack -- --kind plugin --id convax-pet
```

Then commit:

```sh
git add README.md README.zh-CN.md docs packages/plugins/convax-pet registry/config.json schemas tooling bun.lock
git commit -m "feat(plugin): ship pet feature plugin"
```

### Task 8: Mirror and validate the feature contract in Convax

**Files:**
- Modify: `packages/desktop/src/plugin-contracts.ts`
- Modify: `packages/desktop/src/plugin-contracts.test.ts`
- Modify: `packages/desktop/src/main/plugin-manager.ts`
- Modify: `packages/desktop/src/main/plugin-manager.test.ts`
- Create: `packages/desktop/src/main/pet-library.ts`
- Create: `packages/desktop/src/main/pet-library.test.ts`

- [ ] **Step 1: Write failing host parser and installer tests**

Mirror the Task 1 and Task 2 fixtures. Assert exact capabilities and contribution,
every required regular file, strict library JSON, unique IDs, safe package paths,
and every atlas inspection. Assert that the old one-spritesheet contribution and
raw runtime are rejected.

- [ ] **Step 2: Confirm RED**

Run:

```sh
bun test packages/desktop/src/plugin-contracts.test.ts packages/desktop/src/main/plugin-manager.test.ts packages/desktop/src/main/pet-library.test.ts
```

- [ ] **Step 3: Implement mirrored parsing and inert validation**

Define:

```ts
export interface WebPluginPetContribution {
  library: string
  overlay: string
  settings: string
  protocol: "convax.pet-host/1"
}
```

Create a strict `parseInstalledPetLibrary` that returns immutable metadata and
validated package paths. Reuse `PetAssetInspector` for every atlas. Keep validation
generic and avoid checking `plugin.id === "convax-pet"`.

- [ ] **Step 4: Confirm GREEN and commit**

Run the focused tests and desktop typecheck, then:

```sh
git add packages/desktop/src/plugin-contracts.ts packages/desktop/src/plugin-contracts.test.ts packages/desktop/src/main/plugin-manager.ts packages/desktop/src/main/plugin-manager.test.ts packages/desktop/src/main/pet-library.ts packages/desktop/src/main/pet-library.test.ts
git commit -m "feat(desktop): validate pet feature providers"
```

### Task 9: Define and enforce `convax.pet-host/1`

**Files:**
- Modify: `packages/desktop/src/pet-contracts.ts`
- Create: `packages/desktop/src/main/pet-host-connection.ts`
- Create: `packages/desktop/src/main/pet-host-connection.test.ts`

- [ ] **Step 1: Write failing protocol tests**

Test exact request envelopes, maximum IDs and payloads, overlay/settings method
allowlists, capability checks, provider generation binding, activity event delivery,
close behavior, and rejection of methods such as import, filesystem access, generic
IPC, or a settings-origin activity request.

- [ ] **Step 2: Confirm RED**

Run `bun test packages/desktop/src/main/pet-host-connection.test.ts`.

- [ ] **Step 3: Implement the protocol dispatcher**

Add discriminated TypeScript request/response/event types with protocol literal
`convax.pet-host/1`. Implement separate overlay and settings connections. Dispatch
only the five operation groups from the approved design, clone every result, and
invalidate pending requests when the installed provider digest changes.

- [ ] **Step 4: Confirm GREEN and commit**

Run focused tests plus desktop typecheck, then:

```sh
git add packages/desktop/src/pet-contracts.ts packages/desktop/src/main/pet-host-connection.ts packages/desktop/src/main/pet-host-connection.test.ts
git commit -m "feat(desktop): add scoped pet host protocol"
```

### Task 10: Replace pet inventory management with provider lifecycle

**Files:**
- Create: `packages/desktop/src/main/pet-provider-controller.ts`
- Create: `packages/desktop/src/main/pet-provider-controller.test.ts`
- Modify: `packages/desktop/src/main/pet-state-store.ts`
- Modify: `packages/desktop/src/main/pet-state-store.test.ts`

- [ ] **Step 1: Write failing provider lifecycle tests**

Test no provider, one provider, deterministic singleton conflict rejection,
explicit wake, tuck, provider update generation change, provider uninstall, bounded
`selectedPetId`, stale selection left for Plugin fallback, activity subscription only
while awake, and persistence of display/acknowledgement state.

- [ ] **Step 2: Confirm RED**

Run:

```sh
bun test packages/desktop/src/main/pet-provider-controller.test.ts packages/desktop/src/main/pet-state-store.test.ts
```

- [ ] **Step 3: Implement provider state**

Replace `PetSelection` and custom-pet state with:

```ts
interface PetPersistedState {
  schema: "convax.pet-state/1"
  awake: boolean
  providerId?: string
  preferences: { selectedPetId?: string }
  displayId?: string
  positions: Record<string, { x: number; y: number; scaleFactor?: number }>
  seen: Record<string, number>
}
```

The controller selects the contribution generically, owns no pet library metadata,
and opens the provider overlay URL only after explicit wake.

- [ ] **Step 4: Confirm GREEN and commit**

Run focused tests plus typecheck, then:

```sh
git add packages/desktop/src/main/pet-provider-controller.ts packages/desktop/src/main/pet-provider-controller.test.ts packages/desktop/src/main/pet-state-store.ts packages/desktop/src/main/pet-state-store.test.ts
git commit -m "feat(desktop): manage pet feature provider"
```

### Task 11: Load Plugin content in the isolated native overlay

**Files:**
- Modify: `packages/desktop/src/main/pet-window.ts`
- Modify: `packages/desktop/src/main/pet-window.test.ts`
- Modify: `packages/desktop/src/main/pet-session.ts`
- Modify: `packages/desktop/src/main/pet-session.test.ts`
- Modify: `packages/desktop/src/preload/pet.ts`
- Modify: `packages/desktop/electron.vite.config.ts`
- Modify: `packages/desktop/electron.vite.config.test.ts`

- [ ] **Step 1: Write failing isolated-overlay tests**

Require the window URL to be the selected provider's exact `convax-plugin://` overlay
entry, the `convax-plugin` handler to be registered on `convax-pet-overlay`, strict
same-provider navigation, fixed sandbox preload, no host pet renderer build entry,
and one crash restart before tuck.

- [ ] **Step 2: Confirm RED**

Run the four affected test files.

Expected: the window still loads host `pet/index.html` and the session registers
`convax-pet-asset`.

- [ ] **Step 3: Implement Plugin overlay loading**

Reuse `createWebPluginAssetHandler` with a Pet-surface CSP/frame-ancestor option and
the installed manager resolver. Register/unregister it on the nonpersistent Pet
session. Keep display clamping, inactive show, drag, resize, permission denial, and
crash recovery. Change the preload from presentation logic to a fixed scoped host
connector.

- [ ] **Step 4: Confirm GREEN and commit**

Run focused tests, desktop typecheck, and the desktop production build, then:

```sh
git add packages/desktop/src/main/pet-window.ts packages/desktop/src/main/pet-window.test.ts packages/desktop/src/main/pet-session.ts packages/desktop/src/main/pet-session.test.ts packages/desktop/src/preload/pet.ts packages/desktop/electron.vite.config.ts packages/desktop/electron.vite.config.test.ts
git commit -m "feat(desktop): host plugin-owned pet overlay"
```

### Task 12: Mount the Plugin-owned settings surface

**Files:**
- Create: `packages/desktop/src/renderer/pet-settings-host.tsx`
- Create: `packages/desktop/src/renderer/pet-settings-host.test.tsx`
- Modify: `packages/desktop/src/renderer/settings-view.tsx`
- Modify: `packages/desktop/src/renderer/settings-view.test.tsx`
- Modify: `packages/desktop/src/preload/index.ts`
- Modify: `packages/desktop/src/renderer/env.d.ts`

- [ ] **Step 1: Write failing settings-host tests**

Test that no provider hides the Pet section, one provider renders an iframe with
exact `sandbox="allow-scripts"`, the frame receives one settings-scoped port after
load, disconnects on unmount/provider change, and cannot request overlay activity
methods. Verify there is no host-rendered pet card or import button.

- [ ] **Step 2: Confirm RED**

Run:

```sh
bun test packages/desktop/src/renderer/pet-settings-host.test.tsx packages/desktop/src/renderer/settings-view.test.tsx
```

- [ ] **Step 3: Implement the frame host**

Use the installed provider settings URL and existing Plugin iframe navigation
guards. Transfer a fresh MessageChannel to the frame and relay only the settings
connection. Keep the host shell limited to section navigation, loading, and
provider-unavailable fallback.

- [ ] **Step 4: Confirm GREEN and commit**

Run focused tests and desktop typecheck, then:

```sh
git add packages/desktop/src/renderer/pet-settings-host.tsx packages/desktop/src/renderer/pet-settings-host.test.tsx packages/desktop/src/renderer/settings-view.tsx packages/desktop/src/renderer/settings-view.test.tsx packages/desktop/src/preload/index.ts packages/desktop/src/renderer/env.d.ts
git commit -m "feat(desktop): mount plugin pet settings"
```

### Task 13: Compose activity, navigation, IPC, and application lifecycle

**Files:**
- Modify: `packages/desktop/src/main/pet-ipc.ts`
- Modify: `packages/desktop/src/main/pet-ipc.test.ts`
- Modify: `packages/desktop/src/main/index.ts`
- Modify: `packages/desktop/src/main/application-lifecycle.ts`
- Modify: `packages/desktop/src/main/application-lifecycle.test.ts`
- Modify: `packages/desktop/src/renderer/agent-panel.tsx`
- Modify: `packages/desktop/src/renderer/app-language.ts`

- [ ] **Step 1: Write failing composition tests**

Test trusted sender checks, port creation for exact provider generations, activity
snapshot/event forwarding, stale navigation rejection, focus/restore/open behavior,
mark-displayed acknowledgements, provider install/update/uninstall refresh, and
shutdown disposal order. Assert no file picker or custom-pet IPC channel remains.

- [ ] **Step 2: Confirm RED**

Run the affected main/lifecycle/agent tests.

- [ ] **Step 3: Implement application composition**

Wire `AgentActivityController` to the provider's overlay connection instead of the
host renderer. Route opaque activity open through the existing main-window restore
and navigation flow. Refresh the singleton provider on Plugin lifecycle changes.
Start global activity recovery only while an enabled provider is awake. Keep the
generic “Pets” section label in the host; move all pet-specific copy into the
Plugin.

- [ ] **Step 4: Confirm GREEN and commit**

Run focused tests and desktop typecheck, then:

```sh
git add packages/desktop/src/main/pet-ipc.ts packages/desktop/src/main/pet-ipc.test.ts packages/desktop/src/main/index.ts packages/desktop/src/main/application-lifecycle.ts packages/desktop/src/main/application-lifecycle.test.ts packages/desktop/src/renderer/agent-panel.tsx packages/desktop/src/renderer/app-language.ts
git commit -m "feat(desktop): compose pet feature plugin"
```

### Task 14: Remove superseded host product code and raw import

**Files:**
- Delete: `packages/desktop/src/main/pet-controller.ts`
- Delete: `packages/desktop/src/main/pet-controller.test.ts`
- Delete: `packages/desktop/src/main/pet-asset-protocol.ts`
- Delete: `packages/desktop/src/main/pet-asset-protocol.test.ts`
- Delete: `packages/desktop/src/renderer/pet-settings.tsx`
- Delete: `packages/desktop/src/renderer/pet-settings.test.tsx`
- Delete: `packages/desktop/src/renderer/pet/index.html`
- Delete: `packages/desktop/src/renderer/pet/index.tsx`
- Delete: `packages/desktop/src/renderer/pet/pet-entry.test.ts`
- Delete: `packages/desktop/src/renderer/pet/pet-view.tsx`
- Delete: `packages/desktop/src/renderer/pet/pet-view.test.tsx`
- Delete: `packages/desktop/src/renderer/pet/styles.css`
- Modify: `packages/desktop/src/renderer/index.html`

- [ ] **Step 1: Add a boundary regression test**

Assert the Convax source tree contains no Violet string, animation table,
`importCustom`, `deleteCustom`, `custom-pet`, raw spritesheet picker, host pet card,
or `convax-pet-asset` scheme, while `AgentActivityController`, `PetWindow`, provider
controller, and host protocol remain.

- [ ] **Step 2: Confirm RED**

Run the boundary test and expect matches from the prototype.

- [ ] **Step 3: Delete superseded files and references**

Remove the host renderer bundle, raw import/storage branches, obsolete CSP scheme,
and old tests only after Tasks 8–13 are green. Preserve asset inspection because
the installer still validates packaged library atlases.

- [ ] **Step 4: Confirm GREEN and commit**

Run desktop typecheck and all Pet/Plugin tests, then:

```sh
git add packages/desktop
git commit -m "refactor(desktop): remove host-owned pet product"
```

### Task 15: End-to-end verification and review

**Files:**
- Modify only files required by failures found during verification.

- [ ] **Step 1: Run complete `convax-plugins` verification**

```sh
bun install --frozen-lockfile --ignore-scripts
bun run workspaces:build:packages
bun run validate
bun run workspaces:typecheck
bun run workspaces:test
bun run build:companions
bun test
bun run pack
bun run build:index
```

Expected: every command exits zero; the Convax Pet ZIP contains both surfaces,
library JSON, browser modules, Violet, manifest, README, and license at ZIP root.

- [ ] **Step 2: Run complete Convax verification**

```sh
bun run check
```

Expected: lint/typecheck/tests/package boundaries/production build/Electron smoke
all pass. Run the focused Pet suites separately if output truncation hides counts.

- [ ] **Step 3: Run acceptance smoke**

Install the locally packed `convax-pet` ZIP in a built Convax app, verify Plugin
settings ownership, select/wake Violet, simulate running/needs-input/ready/blocked,
navigate from the tray, toggle reduced motion, restart, and uninstall. Confirm no
file import control or network request exists.

- [ ] **Step 4: Request two-scope review**

Review `convax-plugins` for manifest/package/security correctness and Convax for
protocol/session/lifecycle correctness. Fix every Critical or Important finding
with a failing regression test first, rerun focused and full verification, then
commit fixes using conventional messages.

- [ ] **Step 5: Confirm clean branches**

```sh
git status --short
git log --oneline --decorate -5
```

Expected: both `codex/convax-pet` branches are clean and based on their requested
`main` and `convax-next` branches respectively.
