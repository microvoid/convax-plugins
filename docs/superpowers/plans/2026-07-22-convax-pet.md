# Convax Pet Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship an original Codex-style floating Convax pet as an inert `convax-pet` Plugin plus a generic, secure, cross-project desktop pet host.

**Architecture:** `convax.plugin/5` gains an optional declarative `contributes.pet` value while retaining all existing v5 capabilities and its `convax.plugin-capability/1` compatibility. `@convax/agent-runtime` projects content-free session activity; Convax desktop aggregates it across projects, owns a hardened transparent window and local preferences, and resolves opaque activity navigation in the main process. The Plugin ZIP contains only its manifest, license, README, and Violet sprite atlas.

**Tech Stack:** Bun, TypeScript, JSON Schema 2020-12, React 19, Electron 42, electron-vite, Tailwind/Convax UI tokens, Bun test, PNG/WebP sprite atlases.

**Repositories and branches:**

- `/Users/bytedance/src/convax-plugins` on `codex/convax-pet`, based on local `main`.
- `/Users/bytedance/src/convax` on `codex/convax-pet`, based on local `convax-next`.
- The user explicitly chose direct branches instead of worktrees.

---

## File map

### `/Users/bytedance/src/convax-plugins`

- `schemas/convax-plugin-manifest-v5.schema.json`: public v5 manifest schema, including existing v5 fields and optional `pet`.
- `schemas/convax-package-v1.schema.json`: allow the exact `convax.plugin/5` + `convax.plugin-capability/1` source compatibility pair.
- `schemas/convax-registry-v1.schema.json`: validate the same v5 pair and embedded v5 manifests.
- `tooling/lib.mjs`: parse v5 manifests, pet declarations, package asset paths, and compatibility.
- `tooling/plugin-v5.test.js`: contract, backward-compatibility, and malicious-input tests.
- `tooling/registry.test.js`: Registry and real package coverage.
- `packages/plugins/convax-pet/package.json`: inert Plugin workspace scripts.
- `packages/plugins/convax-pet/convax-package.json`: catalog metadata.
- `packages/plugins/convax-pet/package/manifest.json`: Violet pet contribution.
- `packages/plugins/convax-pet/package/assets/violet.webp`: original 8x9 sprite atlas.
- `packages/plugins/convax-pet/package/LICENSE`: package license.
- `packages/plugins/convax-pet/package/README.md`: asset origin and atlas documentation.
- `registry/config.json`: catalog sequence bump.
- `docs/plugin-authoring.md`, `docs/packaging.md`, `docs/registry-spec.md`: v5 and pet authoring contract.

### `/Users/bytedance/src/convax`

- `packages/agent-runtime/src/contracts.ts`: content-free activity projection types.
- `packages/agent-runtime/src/activity.ts`: deterministic state projection and priority.
- `packages/agent-runtime/src/index.ts`: public activity exports.
- `packages/agent-runtime/test/activity.test.ts`: mapping, priority, privacy, and cancellation tests.
- `packages/desktop/src/plugin-contracts.ts`: `WebPluginPetContribution` and strict v5 parser.
- `packages/desktop/src/plugin-contracts.test.ts`: pet manifest tests that preserve existing v5 behavior.
- `packages/desktop/src/main/pet-asset-inspector.ts`: signature, decode, size, dimensions, and alpha validation.
- `packages/desktop/src/main/plugin-manager.ts`: validate pet resources inside atomic Plugin publication.
- `packages/desktop/src/main/plugin-manager.test.ts`: invalid/missing/tampered pet asset tests.
- `packages/desktop/src/pet-contracts.ts`: renderer-safe snapshots, commands, IPC names, and clients.
- `packages/desktop/src/main/agent-activity-controller.ts`: all-project aggregation, revisions, polling, priority, and read watermarks.
- `packages/desktop/src/main/agent-activity-controller.test.ts`: fake-clock/controller tests.
- `packages/desktop/src/main/pet-state-store.ts`: atomic versioned local state and custom asset records.
- `packages/desktop/src/main/pet-state-store.test.ts`: corruption, clamping input, and bounded watermark tests.
- `packages/desktop/src/main/pet-controller.ts`: pet inventory, custom import, wake/tuck, selection, activity projection, and lifecycle.
- `packages/desktop/src/main/pet-controller.test.ts`: selection/import/update/uninstall/crash behavior.
- `packages/desktop/src/main/pet-window.ts`: hardened BrowserWindow and display positioning.
- `packages/desktop/src/main/pet-window.test.ts`: window flags, navigation blocking, drag clamping, and recovery.
- `packages/desktop/src/main/pet-ipc.ts`: trusted settings and pet-renderer IPC registration.
- `packages/desktop/src/main/pet-ipc.test.ts`: sender/opaque-ID validation.
- `packages/desktop/src/preload/index.ts`: expose the host-rendered settings client.
- `packages/desktop/src/preload/pet.ts`: expose only snapshot, tray, navigation, and drag operations.
- `packages/desktop/src/renderer/env.d.ts`: type both preload surfaces.
- `packages/desktop/src/renderer/pet-settings.tsx`: Convax-styled pet settings surface.
- `packages/desktop/src/renderer/pet-settings.test.tsx`: settings behavior and accessibility.
- `packages/desktop/src/renderer/settings-view.tsx`: add the Pets navigation section.
- `packages/desktop/src/renderer/settings-view.test.tsx`: Pets section integration.
- `packages/desktop/src/renderer/agent-panel.tsx`: host-directed session selection method.
- `packages/desktop/src/renderer/index.tsx`: resolve a trusted navigation event into project/session UI and mark it seen.
- `packages/desktop/src/renderer/pet/index.html`: isolated pet renderer document.
- `packages/desktop/src/renderer/pet/index.tsx`: sprite animation and activity tray.
- `packages/desktop/src/renderer/pet/styles.css`: transparent compact/expanded presentation using Convax tokens.
- `packages/desktop/src/renderer/pet/pet-view.test.tsx`: animation, reduced motion, focus, and interaction tests.
- `packages/desktop/electron.vite.config.ts`: build the pet preload and second renderer entry.
- `packages/desktop/src/main/index.ts`: compose controllers, retain the main-window identity, and register lifecycle cleanup.
- `packages/desktop/src/main/application-lifecycle.test.ts`: main window remains distinct from the pet window.
- `packages/desktop/src/renderer/app-language.ts`: English and Simplified Chinese pet strings.
- `scripts/desktop-open-project-built-smoke.ts`: pet navigation and no-focus-steal smoke assertions.

## Task 1: Publish the existing v5 contract and add the pet declaration

**Repository:** `/Users/bytedance/src/convax-plugins`

**Files:**

- Create: `schemas/convax-plugin-manifest-v5.schema.json`
- Create: `tooling/plugin-v5.test.js`
- Modify: `schemas/convax-package-v1.schema.json`
- Modify: `schemas/convax-registry-v1.schema.json`
- Modify: `tooling/lib.mjs`

- [ ] **Step 1: Write failing v5 contract tests**

Add tests which prove both the pre-existing v5 contract and the new pet-only form:

```js
const pet = {
  schema: "convax.plugin/5",
  id: "convax-pet",
  name: "Convax Pet",
  description: "Adds Violet as a desktop companion.",
  version: "0.1.0",
  capabilities: [],
  contributes: {
    pet: {
      name: "Violet",
      description: "A pixel companion for Convax.",
      spritesheet: "assets/violet.webp",
      spriteVersion: 2,
      alt: "Violet, the Convax pixel companion",
    },
  },
}

test("parses an inert v5 pet as a real capability", () => {
  expect(parsePluginManifest(pet).contributes.pet).toEqual(pet.contributes.pet)
})

test("retains transport-neutral v5 project and LLM declarations", () => {
  expect(parsePluginManifest(existingV5ProjectManifest()).schema).toBe("convax.plugin/5")
  expect(parsePluginManifest(existingV5LlmManifest()).contributes.llm.provider.id).toBe("example")
})

test.each([
  ["remote URL", { spritesheet: "https://example.invalid/pet.webp" }],
  ["traversal", { spritesheet: "../pet.webp" }],
  ["unknown key", { mood: "happy" }],
  ["wrong version", { spriteVersion: 3 }],
])("rejects %s pet declarations", (_label, override) => {
  expect(() => parsePluginManifest({
    ...pet,
    contributes: { pet: { ...pet.contributes.pet, ...override } },
  })).toThrow()
})
```

- [ ] **Step 2: Run the test and confirm the red state**

Run:

```sh
bun test tooling/plugin-v5.test.js
```

Expected: FAIL because v5 is unsupported by the public parser and schema.

- [ ] **Step 3: Add strict v5 parsing without cloning v4 semantics incorrectly**

Add a reusable parser:

```js
function parsePetV5(value, label) {
  exactKeys(value, ["alt", "description", "name", "spritesheet", "spriteVersion"],
    ["alt", "description", "name", "spritesheet", "spriteVersion"], label)
  const spritesheet = parseRelativePath(value.spritesheet, `${label} spritesheet`)
  if (!/\.(?:png|webp)$/.test(spritesheet)) error(label, "spritesheet must be a PNG or WebP file")
  if (value.spriteVersion !== 2) error(label, "spriteVersion must equal 2")
  return {
    alt: cleanString(value.alt, `${label} alt`, 500),
    description: cleanString(value.description, `${label} description`, 2_000),
    name: cleanString(value.name, `${label} name`, 120),
    spritesheet,
    spriteVersion: 2,
  }
}
```

Implement `parsePluginManifestV5` from the actual Convax v5 rules: project-wide capabilities, optional `llm`, owned Skills, existing executable declarations, and `pet`. Count `pet` as a valid non-executable Plugin capability. Do not allow `pet` in v1-v4.

- [ ] **Step 4: Add the exact v5 JSON Schema and compatibility pair**

The compatibility value must be:

```json
{
  "pluginSchema": "convax.plugin/5",
  "pluginHost": "convax.plugin-capability/1"
}
```

The v5 `pet` schema is:

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": ["name", "description", "spritesheet", "spriteVersion", "alt"],
  "properties": {
    "name": { "type": "string", "minLength": 1, "maxLength": 120 },
    "description": { "type": "string", "minLength": 1, "maxLength": 2000 },
    "spritesheet": { "type": "string", "pattern": "^(?!/)(?!.*(?:^|/)\\.\\.(?:/|$))[^\\\\]+\\.(?:png|webp)$", "maxLength": 1024 },
    "spriteVersion": { "const": 2 },
    "alt": { "type": "string", "minLength": 1, "maxLength": 500 }
  }
}
```

- [ ] **Step 5: Run focused and schema tests**

Run:

```sh
bun test tooling/plugin-v5.test.js tooling/plugin-v4.test.js tooling/registry.test.js
bun run validate
```

Expected: PASS, with old v1-v4 fixtures unchanged.

- [ ] **Step 6: Commit the public contract**

```sh
git add schemas tooling/lib.mjs tooling/plugin-v5.test.js
git commit -m "feat(plugin): add v5 pet contribution contract"
```

## Task 2: Add host-side manifest and package asset validation

**Repository:** `/Users/bytedance/src/convax`

**Files:**

- Modify: `packages/desktop/src/plugin-contracts.ts`
- Modify: `packages/desktop/src/plugin-contracts.test.ts`
- Create: `packages/desktop/src/main/pet-asset-inspector.ts`
- Create: `packages/desktop/src/main/pet-asset-inspector.test.ts`
- Modify: `packages/desktop/src/main/plugin-manager.ts`
- Modify: `packages/desktop/src/main/plugin-manager.test.ts`

- [ ] **Step 1: Write failing manifest tests**

```ts
const petManifest = {
  capabilities: [],
  contributes: {
    pet: {
      alt: "Violet, the Convax pixel companion",
      description: "A pixel companion for Convax.",
      name: "Violet",
      spritesheet: "assets/violet.webp",
      spriteVersion: 2,
    },
  },
  description: "Adds Violet as a desktop companion.",
  id: "convax-pet",
  name: "Convax Pet",
  schema: "convax.plugin/5",
  version: "0.1.0",
}

expect(parseWebPluginManifest(petManifest).contributes.pet).toEqual(petManifest.contributes.pet)
expect(() => parseWebPluginManifest({ ...petManifest, schema: "convax.plugin/4" })).toThrow("unsupported field")
```

- [ ] **Step 2: Run the parser test and confirm failure**

```sh
bun test packages/desktop/src/plugin-contracts.test.ts
```

Expected: FAIL with `Plugin contributions contains an unsupported field: pet`.

- [ ] **Step 3: Add typed parsing**

```ts
export interface WebPluginPetContribution {
  alt: string
  description: string
  name: string
  spritesheet: string
  spriteVersion: 2
}

function parsePet(value: unknown): WebPluginPetContribution {
  const input = asRecord(value, "Pet contribution")
  assertKeys(input, ["alt", "description", "name", "spritesheet", "spriteVersion"], "Pet contribution")
  const spritesheet = requireWebPluginRelativePath(input.spritesheet, "Pet spritesheet")
  if (!/\.(?:png|webp)$/.test(spritesheet)) throw new Error("Pet spritesheet must be a PNG or WebP file")
  if (input.spriteVersion !== 2) throw new Error("Pet spriteVersion must equal 2")
  return {
    alt: requireString(input.alt, "Pet alt", 500),
    description: requireString(input.description, "Pet description", 2_000),
    name: requireString(input.name, "Pet name", 120),
    spritesheet,
    spriteVersion: 2,
  }
}
```

Include `pet` only in the v5 contribution key list and in the v5 capability-presence check.

- [ ] **Step 4: Write failing asset inspector and atomic-install tests**

Test exact requirements and injection at the transaction boundary:

```ts
expect(await inspectPetAsset(validWebp)).toMatchObject({
  format: "webp",
  hasTransparency: true,
  height: 1872,
  width: 1536,
})
await expect(manager.installBundle(bundleWithMissingPet())).rejects.toThrow("Pet spritesheet does not exist")
await expect(manager.installBundle(bundleWithWrongSize())).rejects.toThrow("1536 by 1872")
expect(await manager.list()).toEqual([])
```

- [ ] **Step 5: Implement Electron-backed decoded inspection behind an injected port**

```ts
export interface PetAssetInspection {
  format: "png" | "webp"
  hasTransparency: boolean
  height: number
  width: number
}

export interface PetAssetInspector {
  inspect(path: string): Promise<PetAssetInspection>
}

export function createElectronPetAssetInspector(nativeImage: typeof import("electron").nativeImage): PetAssetInspector {
  return {
    async inspect(path) {
      const image = nativeImage.createFromPath(path)
      if (image.isEmpty()) throw new Error("Pet spritesheet could not be decoded")
      const { width, height } = image.getSize()
      const bitmap = image.toBitmap({ scaleFactor: 1 })
      let hasTransparency = false
      for (let offset = 3; offset < bitmap.length; offset += 4) {
        if (bitmap[offset] < 255) { hasTransparency = true; break }
      }
      return { format: path.toLowerCase().endsWith(".png") ? "png" : "webp", hasTransparency, height, width }
    },
  }
}
```

Validate magic bytes before decode, enforce at most 20 MiB for custom imports, and enforce 1536×1872 plus transparency. `WebPluginManager` receives the inspector as an optional constructor dependency and validates the declared resource during staging before publication.

- [ ] **Step 6: Run tests**

```sh
bun test packages/desktop/src/plugin-contracts.test.ts packages/desktop/src/main/pet-asset-inspector.test.ts packages/desktop/src/main/plugin-manager.test.ts
```

Expected: PASS and existing publication rollback tests remain green.

- [ ] **Step 7: Commit**

```sh
git add packages/desktop/src/plugin-contracts.ts packages/desktop/src/plugin-contracts.test.ts packages/desktop/src/main/pet-asset-inspector.ts packages/desktop/src/main/pet-asset-inspector.test.ts packages/desktop/src/main/plugin-manager.ts packages/desktop/src/main/plugin-manager.test.ts
git commit -m "feat(desktop): validate declarative pet assets"
```

## Task 3: Add content-free agent activity projection

**Repository:** `/Users/bytedance/src/convax`

**Files:**

- Create: `packages/agent-runtime/src/activity.ts`
- Create: `packages/agent-runtime/test/activity.test.ts`
- Modify: `packages/agent-runtime/src/contracts.ts`
- Modify: `packages/agent-runtime/src/index.ts`

- [ ] **Step 1: Write failing pure-function tests**

```ts
expect(projectAgentActivity(state({ pendingQuestions: [question] }))).toMatchObject({ state: "needs-input", input: "question" })
expect(projectAgentActivity(state({ pendingPermissions: [permission] }))).toMatchObject({ state: "needs-input", input: "permission" })
expect(projectAgentActivity(state({ status: { type: "retry", attempt: 2, message: "secret", next: 1 } }))).toEqual({ state: "running" })
expect(projectAgentActivity(failedState("secret error"))).toEqual({ state: "blocked" })
expect(JSON.stringify(projectAgentActivity(failedState("secret error")))).not.toContain("secret")
expect(compareAgentActivity({ state: "needs-input" }, { state: "blocked" })).toBeLessThan(0)
```

- [ ] **Step 2: Run and confirm failure**

```sh
bun test packages/agent-runtime/test/activity.test.ts
```

Expected: FAIL because `activity.ts` does not exist.

- [ ] **Step 3: Implement the minimal public projection**

```ts
export type AgentActivityState =
  | { state: "needs-input"; input: "permission" | "question" }
  | { state: "blocked" }
  | { state: "ready" }
  | { state: "running" }
  | { state: "idle" }

export const agentActivityPriority = {
  "needs-input": 0,
  blocked: 1,
  ready: 2,
  running: 3,
  idle: 4,
} as const
```

`projectAgentActivity` reads status, pending arrays, and only the terminal presence/error flags of the latest assistant message. It never returns message parts, errors, retry text, permission metadata, or question text. Accept a `{ canceled?: boolean; seenAfter?: number }` context so user cancellation maps to idle and successful unseen completion maps to ready.

- [ ] **Step 4: Run package tests and typecheck**

```sh
bun --cwd packages/agent-runtime test
bun --cwd packages/agent-runtime typecheck
```

Expected: PASS.

- [ ] **Step 5: Commit**

```sh
git add packages/agent-runtime
git commit -m "feat(agent-runtime): project session activity safely"
```

## Task 4: Aggregate activity across every project

**Repository:** `/Users/bytedance/src/convax`

**Files:**

- Create: `packages/desktop/src/pet-contracts.ts`
- Create: `packages/desktop/src/main/agent-activity-controller.ts`
- Create: `packages/desktop/src/main/agent-activity-controller.test.ts`
- Modify: `packages/desktop/src/main/agent-ipc.ts`
- Modify: `packages/desktop/src/main/open-project-ipc.test.ts`

- [ ] **Step 1: Write controller tests with fake projects/runtime/clock**

```ts
const controller = new AgentActivityController({ clock, projects, runtime, pollMs: 700 })
await controller.start()
expect(controller.getSnapshot().activities.map(({ projectId, state }) => [projectId, state])).toEqual([
  ["project-b", "needs-input"],
  ["project-a", "running"],
])
expect(controller.getSnapshot()).not.toHaveProperty("messages")
expect(JSON.stringify(controller.getSnapshot())).not.toContain("/private/project")
```

Cover startup recovery, same-priority recency, stale revision rejection, missing projects, runtime backoff, a bounded activity count, mark-seen, retry, and cancellation.

- [ ] **Step 2: Run and confirm failure**

```sh
bun test packages/desktop/src/main/agent-activity-controller.test.ts
```

Expected: FAIL because the controller does not exist.

- [ ] **Step 3: Define the renderer-safe contract**

```ts
export interface PetActivitySummary {
  id: string
  input?: "permission" | "question"
  projectId: string
  projectName: string
  sessionId: string
  sessionName: string
  state: "needs-input" | "blocked" | "ready" | "running"
  updatedAt: number
}

export interface PetActivitySnapshot {
  activities: PetActivitySummary[]
  revision: number
}
```

Create opaque IDs with `randomUUID()` and retain their project/session mapping only in main memory.

- [ ] **Step 4: Implement aggregation and mutation hooks**

`start()` enumerates `projects.list()` and runtime sessions, skips missing projects, and polls only active or recoverable sessions. Add `promptStarted`, `promptSettled`, `aborted`, `permissionReplied`, `questionReplied`, `projectChanged`, and `markSeen`. Every accepted mutation increments one monotonic revision. Cap retained activities and watermarks at 256 each.

Wrap the existing `registerAgentIpc` operations:

```ts
activity.promptStarted(input.scopeId, input.sessionId)
try {
  const result = await runtime.prompt(runtimeInput)
  await activity.promptSettled(input.scopeId, input.sessionId)
  return result
} catch (error) {
  await activity.promptSettled(input.scopeId, input.sessionId, { failed: true })
  throw error
}
```

- [ ] **Step 5: Run focused desktop tests**

```sh
bun test packages/desktop/src/main/agent-activity-controller.test.ts packages/desktop/src/main/open-project-ipc.test.ts
bun --cwd packages/desktop typecheck
```

Expected: PASS.

- [ ] **Step 6: Commit**

```sh
git add packages/desktop/src/pet-contracts.ts packages/desktop/src/main/agent-activity-controller.ts packages/desktop/src/main/agent-activity-controller.test.ts packages/desktop/src/main/agent-ipc.ts packages/desktop/src/main/open-project-ipc.test.ts
git commit -m "feat(desktop): aggregate agent activity across projects"
```

## Task 5: Persist pet selection, position, and read watermarks

**Repository:** `/Users/bytedance/src/convax`

**Files:**

- Create: `packages/desktop/src/main/pet-state-store.ts`
- Create: `packages/desktop/src/main/pet-state-store.test.ts`

- [ ] **Step 1: Write failing persistence tests**

```ts
await store.write({ awake: true, positions: { displayA: { x: 40, y: 60 } }, selected: { kind: "plugin", pluginId: "convax-pet" }, seen: {} })
expect(await store.read()).toMatchObject({ awake: true, schema: "convax.pet-state/1" })
await writeFile(file, "{broken")
expect(await store.read()).toEqual(defaultPetState)
expect(Object.keys(boundState({ seen: hugeSeen }).seen)).toHaveLength(256)
```

- [ ] **Step 2: Run and confirm failure**

```sh
bun test packages/desktop/src/main/pet-state-store.test.ts
```

- [ ] **Step 3: Implement strict versioned atomic storage**

Write mode `0600` to a sibling UUID temporary file, `fsync`, rename, then best-effort directory `fsync`. Parse exact keys and finite safe coordinates. The state contains only selection, awake state, per-display positions, and bounded timestamps.

```ts
export interface PetPersistedState {
  awake: boolean
  positions: Record<string, { x: number; y: number }>
  schema: "convax.pet-state/1"
  seen: Record<string, number>
  selected?: { kind: "plugin"; pluginId: string } | { id: string; kind: "custom" }
}
```

- [ ] **Step 4: Run tests and commit**

```sh
bun test packages/desktop/src/main/pet-state-store.test.ts
git add packages/desktop/src/main/pet-state-store.ts packages/desktop/src/main/pet-state-store.test.ts
git commit -m "feat(desktop): persist local pet state"
```

## Task 6: Build the generic pet controller and custom import flow

**Repository:** `/Users/bytedance/src/convax`

**Files:**

- Create: `packages/desktop/src/main/pet-controller.ts`
- Create: `packages/desktop/src/main/pet-controller.test.ts`
- Modify: `packages/desktop/src/pet-contracts.ts`

- [ ] **Step 1: Write failing inventory/lifecycle/import tests**

```ts
expect((await controller.listPets()).pets).toEqual([
  expect.objectContaining({ id: "plugin:convax-pet", name: "Violet", source: "plugin" }),
])
await controller.select("plugin:convax-pet")
expect(window.open).not.toHaveBeenCalled()
await controller.setAwake(true)
expect(window.open).toHaveBeenCalledTimes(1)
await controller.beforePluginChange("convax-pet")
expect(window.close).toHaveBeenCalled()
await expect(controller.importCustom(invalidPath)).rejects.toThrow("1536 by 1872")
expect(await readdir(staging)).toEqual([])
```

- [ ] **Step 2: Run and confirm failure**

```sh
bun test packages/desktop/src/main/pet-controller.test.ts
```

- [ ] **Step 3: Implement host-owned inventory and selection**

Inventory maps any installed manifest with `contributes.pet`; no branch may compare `plugin.id` with `convax-pet`. Resolve the asset only with `pluginManager.resolveAsset(plugin.id, pet.spritesheet)`. Selecting does not wake. Uninstalling the selected source closes the window and clears selection.

- [ ] **Step 4: Implement staged custom import**

Copy the selected PNG/WebP into `userData/pets/.staging-<uuid>`, run the same inspector, generate an opaque custom ID, and atomically rename to `userData/pets/<id>/spritesheet.<ext>`. Store a host-authored metadata JSON; never store or expose the original path.

- [ ] **Step 5: Run tests and commit**

```sh
bun test packages/desktop/src/main/pet-controller.test.ts packages/desktop/src/main/pet-state-store.test.ts
git add packages/desktop/src/pet-contracts.ts packages/desktop/src/main/pet-controller.ts packages/desktop/src/main/pet-controller.test.ts
git commit -m "feat(desktop): manage installed and custom pets"
```

## Task 7: Create the hardened floating pet window

**Repository:** `/Users/bytedance/src/convax`

**Files:**

- Create: `packages/desktop/src/main/pet-window.ts`
- Create: `packages/desktop/src/main/pet-window.test.ts`
- Modify: `packages/desktop/src/main/index.ts`
- Modify: `packages/desktop/src/main/application-lifecycle.test.ts`

- [ ] **Step 1: Write failing BrowserWindow and display tests**

```ts
expect(created.options).toMatchObject({
  alwaysOnTop: true,
  frame: false,
  height: 176,
  show: false,
  skipTaskbar: true,
  transparent: true,
  width: 176,
  webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
})
expect(created.windowOpenHandler()).toEqual({ action: "deny" })
expect(clampPetBounds({ x: 5000, y: -20 }, display.workArea, { width: 176, height: 176 })).toEqual(expected)
```

Also prove that an existing pet window does not prevent `app.activate` from recreating a missing main window.

- [ ] **Step 2: Run and confirm failure**

```sh
bun test packages/desktop/src/main/pet-window.test.ts packages/desktop/src/main/application-lifecycle.test.ts
```

- [ ] **Step 3: Implement the window boundary**

Use a dedicated pet preload, fixed local renderer URL, `setWindowOpenHandler(() => ({action: "deny"}))`, prevent all non-exact main-frame navigation, deny permissions/downloads, and never add pet webContents to the main renderer trust set. `showInactive()` avoids focus stealing.

Retain `mainWindow` explicitly in `main/index.ts`; replace `getAllWindows()[0]` and `getAllWindows().length` assumptions used by second-instance and activate paths.

- [ ] **Step 4: Add crash and display lifecycle**

On `render-process-gone`, recreate once per wake generation; a second crash calls `setAwake(false)`. Re-clamp on `display-removed`, `display-metrics-changed`, and system resume. Persist position only after a completed drag.

- [ ] **Step 5: Run tests and commit**

```sh
bun test packages/desktop/src/main/pet-window.test.ts packages/desktop/src/main/application-lifecycle.test.ts
git add packages/desktop/src/main/pet-window.ts packages/desktop/src/main/pet-window.test.ts packages/desktop/src/main/index.ts packages/desktop/src/main/application-lifecycle.test.ts
git commit -m "feat(desktop): add secure floating pet window"
```

## Task 8: Add minimal pet IPC and trusted navigation

**Repository:** `/Users/bytedance/src/convax`

**Files:**

- Create: `packages/desktop/src/main/pet-ipc.ts`
- Create: `packages/desktop/src/main/pet-ipc.test.ts`
- Create: `packages/desktop/src/preload/pet.ts`
- Modify: `packages/desktop/src/preload/index.ts`
- Modify: `packages/desktop/src/renderer/env.d.ts`
- Modify: `packages/desktop/src/renderer/agent-panel.tsx`
- Modify: `packages/desktop/src/renderer/index.tsx`

- [ ] **Step 1: Write failing sender and opaque navigation tests**

```ts
await expect(invokeAsUntrusted("pet:list")).rejects.toThrow("untrusted renderer")
await expect(invokeAsPet("pet:navigate", { activityId: "unknown" })).rejects.toThrow("no longer available")
await invokeAsPet("pet:navigate", { activityId })
expect(mainWindow.webContents.send).toHaveBeenCalledWith("pet:navigate", { activityId, projectId, sessionId })
```

- [ ] **Step 2: Run and confirm failure**

```sh
bun test packages/desktop/src/main/pet-ipc.test.ts
```

- [ ] **Step 3: Define two capability-minimal clients**

The main settings preload exposes list/select/wake/tuck/import/delete and change subscription. The pet preload exposes only current snapshot subscription, tray expansion, opaque navigation, and bounded drag deltas. Neither exposes a path, arbitrary channel, or agent API.

```ts
export interface PetOverlayClient {
  drag(input: { dx: number; dy: number; phase: "move" | "end" }): void
  navigate(input: { activityId: string }): Promise<void>
  onSnapshot(listener: (snapshot: PetOverlaySnapshot) => void): () => void
  setExpanded(input: { expanded: boolean }): Promise<void>
}
```

- [ ] **Step 4: Add host-directed session selection**

Extend the handle without exposing it outside the trusted renderer:

```ts
export interface AgentPanelHandle {
  addResources(resources: readonly AgentResource[]): void
  openSession(sessionId: string): Promise<void>
}
```

In `renderer/index.tsx`, subscribe to `window.convax.pets.onNavigate`, call `await projectController.activate(projectId)`, open the secondary panel, call `agentPanelRef.current?.openSession(sessionId)`, then acknowledge `markDisplayed(activityId)`. Merely opening the pet tray must not mark read.

- [ ] **Step 5: Run tests and commit**

```sh
bun test packages/desktop/src/main/pet-ipc.test.ts packages/desktop/src/renderer/agent-panel.test.tsx
bun --cwd packages/desktop typecheck
git add packages/desktop/src/main/pet-ipc.ts packages/desktop/src/main/pet-ipc.test.ts packages/desktop/src/preload packages/desktop/src/renderer/env.d.ts packages/desktop/src/renderer/agent-panel.tsx packages/desktop/src/renderer/index.tsx
git commit -m "feat(desktop): connect pet activity navigation"
```

## Task 9: Build and test the isolated pet renderer

**Repository:** `/Users/bytedance/src/convax`

**Files:**

- Create: `packages/desktop/src/renderer/pet/index.html`
- Create: `packages/desktop/src/renderer/pet/index.tsx`
- Create: `packages/desktop/src/renderer/pet/styles.css`
- Create: `packages/desktop/src/renderer/pet/pet-view.tsx`
- Create: `packages/desktop/src/renderer/pet/pet-view.test.tsx`
- Modify: `packages/desktop/electron.vite.config.ts`

- [ ] **Step 1: Write failing animation and interaction tests**

```tsx
expect(frameFor({ animation: "idle", elapsed: 0 })).toEqual({ column: 0, row: 0 })
expect(frameFor({ animation: "review", elapsed: 750 }).row).toBe(8)
expect(renderPet({ reducedMotion: true })).not.toContain("animation-timer")
expect(renderPet({ state: "needs-input" })).toContain("Needs input")
expect(renderPet({ state: "blocked" })).toContain("Blocked")
```

Test the 4-pixel drag threshold, jump-before-navigation, maximum four visible rows, keyboard activation, Escape dismissal, and status text independent of color.

- [ ] **Step 2: Run and confirm failure**

```sh
bun test packages/desktop/src/renderer/pet/pet-view.test.tsx
```

- [ ] **Step 3: Implement deterministic atlas animation**

```ts
export const petAnimations = {
  idle: { row: 0, durations: [280, 110, 110, 140, 140, 320] },
  "running-right": { row: 1, durations: [120, 120, 120, 120, 120, 120, 120, 220] },
  "running-left": { row: 2, durations: [120, 120, 120, 120, 120, 120, 120, 220] },
  waving: { row: 3, durations: [140, 140, 140, 280] },
  jumping: { row: 4, durations: [140, 140, 140, 140, 280] },
  failed: { row: 5, durations: [140, 140, 140, 140, 140, 140, 140, 240] },
  waiting: { row: 6, durations: [150, 150, 150, 150, 150, 260] },
  running: { row: 7, durations: [120, 120, 120, 120, 120, 220] },
  review: { row: 8, durations: [150, 150, 150, 150, 150, 280] },
} as const
```

Use `background-size: 800% 900%`, pixelated rendering, a 96×104 pet, a 176×176 collapsed surface, and a 356×320 expanded surface. Urgent states bypass minimum dwell; ordinary state changes wait for the current loop boundary.

- [ ] **Step 4: Add second renderer/preload build entries**

```ts
preload: { build: { rollupOptions: { input: { index: "src/preload/index.ts", pet: "src/preload/pet.ts" } } } },
renderer: { build: { rollupOptions: { input: { index: "src/renderer/index.html", pet: "src/renderer/pet/index.html" } } } },
```

- [ ] **Step 5: Run renderer tests/build and commit**

```sh
bun test packages/desktop/src/renderer/pet/pet-view.test.tsx
bun --cwd packages/desktop build
git add packages/desktop/src/renderer/pet packages/desktop/electron.vite.config.ts
git commit -m "feat(desktop): render animated pet activity"
```

## Task 10: Add Convax-styled pet settings

**Repository:** `/Users/bytedance/src/convax`

**Files:**

- Create: `packages/desktop/src/renderer/pet-settings.tsx`
- Create: `packages/desktop/src/renderer/pet-settings.test.tsx`
- Modify: `packages/desktop/src/renderer/settings-view.tsx`
- Modify: `packages/desktop/src/renderer/settings-view.test.tsx`
- Modify: `packages/desktop/src/renderer/app-language.ts`

- [ ] **Step 1: Write failing UI tests**

```tsx
expect(markup).toContain("Pets")
expect(markup).toContain("Violet")
expect(markup).toContain("Wake pet")
expect(markup).not.toContain("/Users/")
```

Interaction tests cover selection without wake, explicit wake/tuck, import cancellation, invalid-import error, and deletion confirmation for custom pets.

- [ ] **Step 2: Run and confirm failure**

```sh
bun test packages/desktop/src/renderer/pet-settings.test.tsx packages/desktop/src/renderer/settings-view.test.tsx
```

- [ ] **Step 3: Add the Pets section with existing primitives**

Extend `SettingsSection` to include `pets`. Use `Button`, existing rounded card/border styles, `#7657e8` through the primary token, muted text, and existing localization helpers. Do not build a Plugin iframe or special-case Violet's package ID.

- [ ] **Step 4: Run UI tests and commit**

```sh
bun test packages/desktop/src/renderer/pet-settings.test.tsx packages/desktop/src/renderer/settings-view.test.tsx packages/desktop/src/renderer/application-menu.test.tsx
git add packages/desktop/src/renderer/pet-settings.tsx packages/desktop/src/renderer/pet-settings.test.tsx packages/desktop/src/renderer/settings-view.tsx packages/desktop/src/renderer/settings-view.test.tsx packages/desktop/src/renderer/app-language.ts
git commit -m "feat(desktop): add pet preferences"
```

## Task 11: Compose pet lifecycle into the desktop application

**Repository:** `/Users/bytedance/src/convax`

**Files:**

- Modify: `packages/desktop/src/main/index.ts`
- Modify: `packages/desktop/src/main/plugin-management-ipc.test.ts`
- Modify: `packages/desktop/src/main/application-lifecycle.ts`
- Modify: `packages/desktop/src/main/application-lifecycle.test.ts`

- [ ] **Step 1: Write failing composition tests**

Prove that startup reconciles the Plugin manager before selecting a pet, plugin `beforeChange` closes an active asset, `onDidChange` re-resolves the contribution, and will-quit disposes activity polling/window IPC before runtime disposal.

- [ ] **Step 2: Run and confirm failure**

```sh
bun test packages/desktop/src/main/plugin-management-ipc.test.ts packages/desktop/src/main/application-lifecycle.test.ts
```

- [ ] **Step 3: Compose dependencies in ownership order**

```ts
const petAssetInspector = createElectronPetAssetInspector(nativeImage)
const pluginManager = new WebPluginManager(pluginRoot, {}, builtinIds, { petAssetInspector })
const activity = new AgentActivityController({ projects: projectManager, runtime: agentRuntime })
const pets = new PetController({ activity, pluginManager, stateStore, window: petWindow })
```

Compose existing Plugin lifecycle callbacks with `pets.beforePluginChange` and `pets.pluginChanged`; do not replace Skill, generation, service, or provider cleanup. Start activity after project/runtime construction and stop it during will-quit.

- [ ] **Step 4: Run main-process tests and commit**

```sh
bun test packages/desktop/src/main
bun --cwd packages/desktop typecheck
git add packages/desktop/src/main
git commit -m "feat(desktop): compose pet application lifecycle"
```

## Task 12: Create and publish the Violet Plugin package

**Repository:** `/Users/bytedance/src/convax-plugins`

**Files:**

- Create: `packages/plugins/convax-pet/package.json`
- Create: `packages/plugins/convax-pet/convax-package.json`
- Create: `packages/plugins/convax-pet/package/manifest.json`
- Create: `packages/plugins/convax-pet/package/LICENSE`
- Create: `packages/plugins/convax-pet/package/README.md`
- Create: `packages/plugins/convax-pet/package/assets/violet.webp`
- Modify: `registry/config.json`
- Modify: `tooling/registry.test.js`

- [ ] **Step 1: Add failing real-package Registry expectations**

```js
const violet = packages.find((item) => item.metadata.id === "convax-pet")
expect(violet.manifest.contributes.pet).toEqual({
  alt: "Violet, the Convax pixel companion",
  description: "A pixel companion for Convax.",
  name: "Violet",
  spritesheet: "assets/violet.webp",
  spriteVersion: 2,
})
expect(violet.manifest).not.toHaveProperty("entry")
expect(violet.manifest).not.toHaveProperty("runtime")
```

- [ ] **Step 2: Run and confirm failure**

```sh
bun test tooling/registry.test.js
```

- [ ] **Step 3: Generate Violet using the imagegen skill**

Use `imagegen` with this art direction, then inspect the result before adopting it:

```text
Create an original purple pixel-art desktop companion named Violet. Transparent background.
Deliver a clean 8-column by 9-row animation atlas with consistent 192x208 cells: idle,
run right, run left, wave, jump, failed/sad, waiting, working, review/needs-input.
Keep one stable character silhouette, restrained lavender highlights, expressive face and
hands, crisp hard pixel edges, no text, logos, borders, guides, shadows outside the figure,
or resemblance to existing Codex pet characters.
```

Mechanically place/crop validated frames into a 1536×1872 WebP only after visually checking every row. Keep unused cells transparent and the final compressed asset below the repository's 2 MiB per-file limit.

- [ ] **Step 4: Add the inert package**

`convax-package.json` uses:

```json
{
  "schema": "convax.package/1",
  "kind": "plugin",
  "id": "convax-pet",
  "name": "Convax Pet",
  "description": "Adds Violet as a local desktop companion for Convax activity.",
  "version": "0.1.0",
  "license": "MIT",
  "compatibility": {
    "pluginSchema": "convax.plugin/5",
    "pluginHost": "convax.plugin-capability/1"
  },
  "yanked": false
}
```

The package `manifest.json` matches Task 1's pet fixture. The workspace has only `validate` and `pack` scripts. Document the image-generation provenance and manual atlas adjustments without claiming third-party ownership.

- [ ] **Step 5: Bump Registry sequence and run package checks**

Change `registry/config.json` sequence from 22 to 23, then run:

```sh
bun run validate -- --kind plugin --id convax-pet
bun run pack -- --kind plugin --id convax-pet
bun test tooling/plugin-v5.test.js tooling/registry.test.js
```

Expected: the Plugin validates and packs with no executable or dependency content.

- [ ] **Step 6: Commit**

```sh
git add packages/plugins/convax-pet registry/config.json tooling/registry.test.js bun.lock
git commit -m "feat(plugin): add Violet Convax pet"
```

## Task 13: Document the public v5 pet contract

**Repository:** `/Users/bytedance/src/convax-plugins`

**Files:**

- Modify: `README.md`
- Modify: `README.zh-CN.md`
- Modify: `docs/plugin-authoring.md`
- Modify: `docs/packaging.md`
- Modify: `docs/registry-spec.md`

- [ ] **Step 1: Add documentation checks to existing tests where applicable**

Extend Registry/workspace tests so the documented schema file exists and the package README references `contributes.pet`, `spriteVersion: 2`, 1536×1872, and the inert ZIP rule.

- [ ] **Step 2: Update documentation**

Document:

```json
{
  "contributes": {
    "pet": {
      "name": "Violet",
      "description": "A pixel companion for Convax.",
      "spritesheet": "assets/violet.webp",
      "spriteVersion": 2,
      "alt": "Violet, the Convax pixel companion"
    }
  }
}
```

State explicitly that pet Plugins are inert, do not receive a host port, cannot create windows, and use the existing v5 compatibility pair.

- [ ] **Step 3: Run docs-adjacent validation and commit**

```sh
bun run validate
bun test tooling/workspaces.test.js tooling/registry.test.js
git add README.md README.zh-CN.md docs
git commit -m "docs(plugin): document pet contributions"
```

## Task 14: Complete cross-repository verification and smoke testing

**Repositories:** Both

- [ ] **Step 1: Verify `convax-plugins` from a frozen install**

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
git diff --check
```

Expected: every command exits 0; generated `dist/` remains uncommitted.

- [ ] **Step 2: Verify Convax packages and boundaries**

```sh
bun --cwd packages/agent-runtime typecheck
bun --cwd packages/agent-runtime test
bun --cwd packages/desktop typecheck
bun --cwd packages/desktop test
bun --cwd packages/desktop build
bun check
bun --cwd packages/desktop smoke:open-project
git diff --check
```

Expected: every command exits 0.

- [ ] **Step 3: Run the native acceptance checklist**

Install the locally packed Plugin through the existing management UI and verify:

1. Installation does not wake the pet.
2. Selecting Violet and pressing Wake shows the collapsed window without focus theft.
3. Two projects produce the exact global priority order.
4. Permission/question, retry, success, failure, and cancellation map correctly.
5. Clicking the pet opens the exact project/session and only then marks it read.
6. Position survives restart and clamps after display removal/scale change.
7. Reduced motion uses a still frame and no animation timer.
8. Valid custom import succeeds; invalid dimensions, opaque images, URLs, and traversal fail.
9. Updating the selected Plugin preserves selection; uninstall closes and clears it.
10. DevTools/network inspection shows no pet-originated network request.

- [ ] **Step 4: Inspect final branch state**

```sh
git status --short
git log --oneline --decorate -15
```

Expected: only intentional source changes/commits; no `dist`, dependencies, credentials, local state, generated indexes, or temporary art files are tracked.

