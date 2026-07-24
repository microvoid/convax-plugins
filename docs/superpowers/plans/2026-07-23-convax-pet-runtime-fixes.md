# Convax Pet Runtime Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Convax Pet clear genuinely displayed unread work, remain in the current macOS full-screen Space, send background native notifications, drag smoothly, and expand its tray without shaking.

**Architecture:** The static `convax-pet` package keeps gesture and committed-view presentation. Convax Desktop keeps trusted session visibility, activity watermarks, native notifications, full-screen window policy, display clamping, navigation, and persistence. Existing `convax.pet-host/1` Plugin authority does not expand; only the trusted main-renderer preload gains a session-displayed IPC.

**Tech Stack:** Bun tests and workspaces, JavaScript static Plugin surfaces, TypeScript, React, Electron 42, MessagePort Pet host transport, native Electron `BrowserWindow` and `Notification`.

---

## File Map

### `convax-plugins`

- `packages/plugins/convax-pet/package/pet/model.js`: stable screen-coordinate gesture, serialized/coalesced movement, host-confirmed expanded-state reconciliation.
- `packages/plugins/convax-pet/package/pet/app.js`: reuse one movement scheduler and commit the tray view only after Host acknowledgement.
- `packages/plugins/convax-pet/overlay.test.js`: interaction regressions.
- `packages/plugins/convax-pet/package/manifest.json`: release version `0.2.2`.
- `packages/plugins/convax-pet/package.json`: workspace version `0.2.2`.
- `registry/config.json`: next catalog sequence.

### `/Users/bytedance/src/convax`

- `packages/desktop/src/main/pet-window.ts`: bottom-right-anchored resizing and macOS full-screen panel policy.
- `packages/desktop/src/main/pet-window.test.ts`: window and resize regressions.
- `packages/desktop/src/main/agent-activity-controller.ts`: trusted session-visible acknowledgement.
- `packages/desktop/src/main/agent-activity-controller.test.ts`: watermark/read-state regressions.
- `packages/desktop/src/pet-contracts.ts`: trusted renderer IPC payload/channel only.
- `packages/desktop/src/main/pet-ipc.ts`: validate visible-session reports and expose reusable activity opening.
- `packages/desktop/src/main/pet-ipc.test.ts`: IPC trust and navigation tests.
- `packages/desktop/src/preload/index.ts`: bounded main-renderer bridge.
- `packages/desktop/src/renderer/env.d.ts`: renderer bridge type.
- `packages/desktop/src/renderer/agent-panel-state.ts`: pure visible-session predicate.
- `packages/desktop/src/renderer/agent-panel-state.test.ts`: visibility predicate tests.
- `packages/desktop/src/renderer/agent-panel.tsx`: visibility-effect wiring.
- `packages/desktop/src/renderer/agent-panel.test.tsx`: source/wiring boundary test.
- `packages/desktop/src/renderer/index.tsx`: compose trusted acknowledgements into standalone and embedded panels.
- `packages/desktop/src/main/pet-activity-notifier.ts`: background transition detection and native notification lifecycle.
- `packages/desktop/src/main/pet-activity-notifier.test.ts`: notification baseline, policy, click, and disposal tests.
- `packages/desktop/src/main/index.ts`: Electron adapters and cleanup composition.

### Documentation

- `docs/superpowers/specs/2026-07-23-convax-pet-runtime-fixes-design.md`: approved design record.
- `docs/superpowers/plans/2026-07-23-convax-pet-runtime-fixes.md`: this execution plan.

## Task 1: Stabilize Plugin Drag and Tray State

**Files:**
- Modify: `packages/plugins/convax-pet/overlay.test.js`
- Modify: `packages/plugins/convax-pet/package/pet/model.js`
- Modify: `packages/plugins/convax-pet/package/pet/app.js`

- [ ] **Step 1: Write failing screen-coordinate and movement-serialization tests**

Add tests which deliberately move `clientX` in the opposite direction while
`screenX` continues forward, and which hold the first Host request unresolved:

```js
test("uses stable screen coordinates while the native window moves", async () => {
  const { createDragGesture } = await import("./package/pet/model.js")
  const onDrag = mock(() => undefined)
  const gesture = createDragGesture(onDrag)

  gesture.start({ clientX: 80, clientY: 50, screenX: 500, screenY: 300 })
  expect(gesture.move({ clientX: 20, clientY: 50, screenX: 506, screenY: 300 })).toBe(true)
  gesture.end({ clientX: 18, clientY: 48, screenX: 509, screenY: 298 })

  expect(onDrag).toHaveBeenNthCalledWith(1, { dx: 6, dy: 0, phase: "move" })
  expect(onDrag).toHaveBeenNthCalledWith(2, { dx: 3, dy: -2, phase: "end" })
})

test("serializes and coalesces movement before the final commit", async () => {
  const { createMoveScheduler } = await import("./package/pet/model.js")
  let release
  const client = {
    request: mock(() => new Promise((resolve) => {
      release = resolve
    })),
  }
  const scheduler = createMoveScheduler(client)

  scheduler.push({ dx: 2, dy: 1, phase: "move" })
  scheduler.push({ dx: 3, dy: -1, phase: "move" })
  scheduler.push({ dx: 4, dy: 2, phase: "end" })
  expect(client.request).toHaveBeenCalledTimes(1)
  release()
  await Promise.resolve()
  release()
  await scheduler.whenIdle()

  expect(client.request).toHaveBeenNthCalledWith(2, "overlay.move", {
    dx: 7,
    dy: 1,
    phase: "end",
  })
})
```

- [ ] **Step 2: Run the focused Plugin test and verify red**

Run:

```bash
bun test packages/plugins/convax-pet/overlay.test.js
```

Expected: failure because the gesture still uses `clientX`/`clientY` and
`createMoveScheduler` does not exist.

- [ ] **Step 3: Implement stable coordinates and one-flight movement**

Use a point normalizer and a scheduler whose pending batch preserves a final
`end` phase:

```js
function dragPoint(point) {
  return { x: point.screenX, y: point.screenY }
}

export function createMoveScheduler(client) {
  let pending
  let flushing

  async function flush() {
    while (pending) {
      const batch = pending
      pending = undefined
      await moveOverlay(client, batch)
    }
  }

  function ensureFlush() {
    if (flushing) return
    flushing = flush().finally(() => {
      flushing = undefined
      if (pending) ensureFlush()
    })
  }

  function push(input) {
    pending = pending
      ? {
          dx: pending.dx + input.dx,
          dy: pending.dy + input.dy,
          phase: pending.phase === "end" || input.phase === "end" ? "end" : "move",
        }
      : { ...input }
    ensureFlush()
  }

  return {
    push,
    async whenIdle() {
      while (flushing || pending) {
        ensureFlush()
        await flushing
      }
    },
  }
}
```

Update `createDragGesture` to store normalized `{x, y}` points and calculate
every threshold/delta from them. Create one scheduler after the Host client
connects and pass its stable `push` function to every rendered gesture.

- [ ] **Step 4: Write and run the failing committed-expansion test**

Add:

```js
test("commits expanded state only after the host accepts the resize", async () => {
  const { reconcileExpanded } = await import("./package/pet/model.js")
  let release
  const client = {
    request: mock(() => new Promise((resolve) => {
      release = resolve
    })),
  }
  const pending = reconcileExpanded(client, false, true)
  expect(client.request).toHaveBeenCalledWith("overlay.setExpanded", { expanded: true })
  release()
  await expect(pending).resolves.toBe(true)
})
```

Run the same focused test. Expected: the model test passes already, while the
application source contract added below initially fails because it renders
before awaiting reconciliation.

Add this source assertion:

```js
expect(app).toMatch(
  /const reconciled = await reconcileExpanded\(client, previous, next\)[\s\S]*?expanded = reconciled[\s\S]*?render\(\)/,
)
expect(app).not.toMatch(/expanded = next\s+render\(\)/)
```

- [ ] **Step 5: Commit view state only after Host confirmation**

Replace optimistic mutation in `setExpanded` with:

```js
let expansionPending = false

async function setExpanded(next) {
  if (expansionPending || next === expanded) return
  expansionPending = true
  try {
    const reconciled = await reconcileExpanded(client, expanded, next)
    if (reconciled === expanded) return
    expanded = reconciled
    render()
  } finally {
    expansionPending = false
  }
}
```

- [ ] **Step 6: Run the focused Plugin suite and commit**

Run:

```bash
bun test packages/plugins/convax-pet/overlay.test.js
```

Expected: all tests pass.

Commit:

```bash
git add packages/plugins/convax-pet/overlay.test.js packages/plugins/convax-pet/package/pet/model.js packages/plugins/convax-pet/package/pet/app.js
git commit -m "fix(plugin): stabilize pet overlay interactions"
```

## Task 2: Keep the Native Pet Stable in Full Screen and During Resize

**Files:**
- Modify: `/Users/bytedance/src/convax/packages/desktop/src/main/pet-window.test.ts`
- Modify: `/Users/bytedance/src/convax/packages/desktop/src/main/pet-window.ts`

- [ ] **Step 1: Write failing macOS panel and bottom-right-anchor tests**

Extend the fake window with:

```ts
setVisibleOnAllWorkspaces = mock(
  (_visible: boolean, _options: { visibleOnFullScreen: boolean }) => undefined,
)
```

Make the fixture accept `platform: NodeJS.Platform`, then assert:

```ts
expect(created.options).toMatchObject({
  fullscreenable: false,
  type: "panel",
})
expect(created.window.setVisibleOnAllWorkspaces).toHaveBeenCalledWith(true, {
  visibleOnFullScreen: true,
})
```

Add an anchor test:

```ts
const before = value.created[0]!.window.getBounds()
await value.pet.setExpanded(true)
expect(value.created[0]!.window.getBounds()).toEqual({
  height: 320,
  width: 356,
  x: before.x + before.width - 356,
  y: before.y + before.height - 320,
})
await value.pet.setExpanded(false)
expect(value.created[0]!.window.getBounds()).toEqual(before)
```

- [ ] **Step 2: Run and verify red**

Run:

```bash
bun test packages/desktop/src/main/pet-window.test.ts
```

Expected: failure because the native window has no full-screen panel policy and
resizes around its top-left corner.

- [ ] **Step 3: Implement platform policy and stable anchor**

Add `platform?: NodeJS.Platform` to `PetWindowOptions`, default it to
`process.platform`, and create macOS windows with:

```ts
{
  alwaysOnTop: true,
  focusable: true,
  frame: false,
  fullscreenable: false,
  type: platform === "darwin" ? "panel" : undefined,
}
```

After creation:

```ts
if (platform === "darwin") {
  window.setVisibleOnAllWorkspaces?.(true, { visibleOnFullScreen: true })
}
```

Resize from the current bottom-right corner:

```ts
const desired = {
  x: bounds.x + bounds.width - size.width,
  y: bounds.y + bounds.height - size.height,
}
const display = this.#options.screen.getDisplayMatching({ ...desired, ...size })
const position = clampPetBounds(desired, display.workArea, size)
current.setBounds({ ...position, ...size })
```

- [ ] **Step 4: Run the focused suite and commit**

Run the focused test; expected: all pass.

Commit:

```bash
git add packages/desktop/src/main/pet-window.ts packages/desktop/src/main/pet-window.test.ts
git commit -m "fix(desktop): stabilize pet panel window"
```

## Task 3: Make Visible Conversations Clear Terminal Pet Activity

**Files:**
- Modify: `/Users/bytedance/src/convax/packages/desktop/src/main/agent-activity-controller.test.ts`
- Modify: `/Users/bytedance/src/convax/packages/desktop/src/main/agent-activity-controller.ts`

- [ ] **Step 1: Write failing visible-session acknowledgement tests**

Add a completed session and assert:

```ts
await controller.start()
expect(controller.getSnapshot().activities[0]?.state).toBe("ready")
await controller.markSessionDisplayed("project-a", "session-a")
expect(watermarks.markSeen).toHaveBeenCalledWith("project-a\u0000session-a", 500)
expect(controller.getSnapshot().activities).toEqual([])
```

Also assert that unknown, running, and needs-input sessions remain unchanged and
do not persist a terminal watermark.

- [ ] **Step 2: Run and verify red**

Run:

```bash
bun test packages/desktop/src/main/agent-activity-controller.test.ts
```

Expected: failure because `markSessionDisplayed` does not exist.

- [ ] **Step 3: Implement the trusted session boundary**

Add:

```ts
async markSessionDisplayed(projectId: string, sessionId: string) {
  const key = activityKey(projectId, sessionId)
  const record = this.#records.get(key)
  if (!record || (record.state.state !== "ready" && record.state.state !== "blocked")) return
  const generation = this.#nextSessionGeneration(key)
  await this.#watermarks?.markSeen(key, record.updatedAt)
  this.#rememberSeen(key, record.updatedAt)
  if (!this.#isCurrentGeneration(key, generation)) return
  record.state = { state: "idle" }
  this.#publish(true)
}
```

Refactor activity-id acknowledgement to call the same private terminal-record
watermark helper so the two paths cannot drift.

- [ ] **Step 4: Run and commit**

Run the focused test; expected: all pass.

Commit:

```bash
git add packages/desktop/src/main/agent-activity-controller.ts packages/desktop/src/main/agent-activity-controller.test.ts
git commit -m "fix(desktop): acknowledge displayed pet sessions"
```

## Task 4: Add the Trusted Renderer Acknowledgement IPC

**Files:**
- Modify: `/Users/bytedance/src/convax/packages/desktop/src/pet-contracts.ts`
- Modify: `/Users/bytedance/src/convax/packages/desktop/src/main/pet-ipc.ts`
- Modify: `/Users/bytedance/src/convax/packages/desktop/src/main/pet-ipc.test.ts`
- Modify: `/Users/bytedance/src/convax/packages/desktop/src/preload/index.ts`
- Modify: `/Users/bytedance/src/convax/packages/desktop/src/renderer/env.d.ts`

- [ ] **Step 1: Write failing trust and schema tests**

Add `markSessionDisplayed` to the activity fixture and test:

```ts
const markSession = invokeHandlers.get(petIpcChannels.sessionDisplayed)!
await expect(
  markSession(value.untrustedEvent, { projectId: "project-one", sessionId: "session-one" }),
).rejects.toThrow("untrusted")
await expect(markSession(value.trustedEvent, { projectId: "../bad", sessionId: "" })).rejects.toThrow(
  "invalid",
)
await markSession(value.trustedEvent, { projectId: "project-one", sessionId: "session-one" })
expect(value.activity.markSessionDisplayed).toHaveBeenCalledWith("project-one", "session-one")
```

Assert that `registration.openActivity({ activityId, revision })` uses the same
validated navigation route as Plugin-originated `activity.open`.

- [ ] **Step 2: Run and verify red**

Run:

```bash
bun test packages/desktop/src/main/pet-ipc.test.ts
```

Expected: missing channel, activity method, and public registration operation.

- [ ] **Step 3: Implement the bounded bridge**

Define:

```ts
export interface PetDisplayedSession {
  projectId: string
  sessionId: string
}
```

Add `sessionDisplayed: "pet:session-displayed"` to the internal channels. Parse
an exact two-key record with non-empty, trimmed, control-character-free strings
bounded to 128 characters. Register only for the trusted main sender:

```ts
ipcMain.handle(petIpcChannels.sessionDisplayed, async (event, value: unknown) => {
  requireTrusted(event)
  const input = displayedSession(value)
  await activity.markSessionDisplayed(input.projectId, input.sessionId)
})
```

Return `openActivity` on `PetIpcRegistration`, remove the handler on disposal,
and add this preload method:

```ts
markSessionDisplayed: (input: PetDisplayedSession) =>
  ipcRenderer.invoke(petSettingsIpcChannels.sessionDisplayed, input),
```

- [ ] **Step 4: Run and commit**

Run the focused IPC and preload tests. Expected: all pass.

Commit:

```bash
git add packages/desktop/src/pet-contracts.ts packages/desktop/src/main/pet-ipc.ts packages/desktop/src/main/pet-ipc.test.ts packages/desktop/src/preload/index.ts packages/desktop/src/renderer/env.d.ts
git commit -m "feat(desktop): report visible pet conversations"
```

## Task 5: Report Only Actually Visible Agent Conversations

**Files:**
- Modify: `/Users/bytedance/src/convax/packages/desktop/src/renderer/agent-panel-state.ts`
- Modify: `/Users/bytedance/src/convax/packages/desktop/src/renderer/agent-panel-state.test.ts`
- Modify: `/Users/bytedance/src/convax/packages/desktop/src/renderer/agent-panel.tsx`
- Modify: `/Users/bytedance/src/convax/packages/desktop/src/renderer/agent-panel.test.tsx`
- Modify: `/Users/bytedance/src/convax/packages/desktop/src/renderer/index.tsx`

- [ ] **Step 1: Write failing visibility predicate tests**

Define test inputs for open/closed, history-visible, hidden document, missing
state, and mismatched selected state. The positive result is:

```ts
expect(
  displayedAgentSession({
    documentVisible: true,
    historyVisible: false,
    open: true,
    projectId: "project-one",
    selectedSessionId: "session-one",
    stateSessionId: "session-one",
  }),
).toEqual({ projectId: "project-one", sessionId: "session-one" })
```

Every false visibility condition returns `null`.

- [ ] **Step 2: Run and verify red**

Run:

```bash
bun test packages/desktop/src/renderer/agent-panel-state.test.ts
```

Expected: `displayedAgentSession` is missing.

- [ ] **Step 3: Implement the predicate and effect**

Add `onSessionDisplayed?(input: PetDisplayedSession): void` to
`AgentPanelProps`. Use one effect which invokes the predicate immediately and on
`visibilitychange`:

```ts
useEffect(() => {
  const report = () => {
    const displayed = displayedAgentSession({
      documentVisible: document.visibilityState === "visible",
      historyVisible,
      open,
      projectId: props.projectId,
      selectedSessionId: sessionId,
      stateSessionId: sessionState?.session.id,
    })
    if (displayed) props.onSessionDisplayed?.(displayed)
  }
  report()
  document.addEventListener("visibilitychange", report)
  return () => document.removeEventListener("visibilitychange", report)
}, [historyVisible, open, props.onSessionDisplayed, props.projectId, sessionContentKey, sessionId])
```

Compose one stable callback in `index.tsx`:

```ts
const markPetSessionDisplayed = useCallback((input: PetDisplayedSession) => {
  void window.convax.pets.markSessionDisplayed(input).catch(() => undefined)
}, [])
```

Pass it to both standalone and embedded `AgentPanel` instances.

- [ ] **Step 4: Add source wiring assertions, run, and commit**

Assert the panel source contains the visibility listener and the application
source passes `onSessionDisplayed={markPetSessionDisplayed}` to both call sites.

Run:

```bash
bun test packages/desktop/src/renderer/agent-panel-state.test.ts packages/desktop/src/renderer/agent-panel.test.tsx
```

Expected: all pass.

Commit:

```bash
git add packages/desktop/src/renderer/agent-panel-state.ts packages/desktop/src/renderer/agent-panel-state.test.ts packages/desktop/src/renderer/agent-panel.tsx packages/desktop/src/renderer/agent-panel.test.tsx packages/desktop/src/renderer/index.tsx
git commit -m "fix(desktop): clear pet activity when conversations are visible"
```

## Task 6: Send Deduplicated Background Native Notifications

**Files:**
- Create: `/Users/bytedance/src/convax/packages/desktop/src/main/pet-activity-notifier.ts`
- Create: `/Users/bytedance/src/convax/packages/desktop/src/main/pet-activity-notifier.test.ts`
- Modify: `/Users/bytedance/src/convax/packages/desktop/src/main/index.ts`

- [ ] **Step 1: Write failing controller tests**

Use a fake native notification with `show`, `close`, and a click listener. Cover:

```ts
notifier.accept(baseline)
expect(created).toHaveLength(0)
notifier.accept(readyAfterRunning)
expect(created).toHaveLength(1)
expect(created[0]!.options).toEqual({
  body: "Session One · Project One",
  title: "Agent task completed",
})
created[0]!.click()
expect(openActivity).toHaveBeenCalledWith("activity-one")
```

Also verify no notification while the main window is focused, no notification
for `running`, no duplicate for the same state/timestamp, a fresh baseline after
tuck/wake, and close/dispose behavior.

- [ ] **Step 2: Run and verify red**

Run:

```bash
bun test packages/desktop/src/main/pet-activity-notifier.test.ts
```

Expected: module not found.

- [ ] **Step 3: Implement the pure notification controller**

The controller stores `Map<activityId, "${state}:${updatedAt}">`, treats the
first accepted snapshot as a baseline, and calls:

```ts
function notificationCopy(activity: PetActivitySummary) {
  const title =
    activity.state === "ready"
      ? "Agent task completed"
      : activity.state === "blocked"
        ? "Agent task blocked"
        : "Agent needs your input"
  return {
    body: `${activity.sessionName} · ${activity.projectName}`.slice(0, 180),
    title,
  }
}
```

The background predicate is:

```ts
const window = options.getMainWindow()
const background =
  !window ||
  window.isDestroyed() ||
  !window.isVisible() ||
  window.isMinimized() ||
  !window.isFocused()
```

Only `ready`, `blocked`, and `needs-input` transitions create a notification.

- [ ] **Step 4: Compose Electron adapters**

After `pets.initialize()`, construct the notifier with `Notification` from
Electron. Keep each notification alive through close/failure, call `show()`, and
on click re-read the current Pet snapshot:

```ts
async function openNotifiedActivity(activityId: string) {
  const snapshot = pets.getActivitySnapshot()
  if (!snapshot.activities.some((activity) => activity.id === activityId)) return
  await petIpc.openActivity({ activityId, revision: snapshot.revision })
}
```

Subscribe to `pets.subscribeActivity`, reset the notifier when preferences
become tucked, seed an awake provider with its current snapshot, and add notifier
disposal to `disposePetApplication`.

- [ ] **Step 5: Run and commit**

Run notifier, Pet IPC, and provider tests. Expected: all pass.

Commit:

```bash
git add packages/desktop/src/main/pet-activity-notifier.ts packages/desktop/src/main/pet-activity-notifier.test.ts packages/desktop/src/main/index.ts
git commit -m "feat(desktop): notify background pet activity"
```

## Task 7: Version and Catalog the Plugin Fix

**Files:**
- Modify: `packages/plugins/convax-pet/package/manifest.json`
- Modify: `packages/plugins/convax-pet/package.json`
- Modify: `registry/config.json`

- [ ] **Step 1: Write the release metadata**

Change both Plugin versions from `0.2.1` to `0.2.2`. Read the latest
`registry/config.json` after synchronizing the branch and increment its current
sequence exactly once.

- [ ] **Step 2: Run package validation**

Run:

```bash
bun run --cwd packages/plugins/convax-pet validate
bun run --cwd packages/plugins/convax-pet test
```

Expected: the package and metadata validate and all Plugin tests pass.

- [ ] **Step 3: Commit**

```bash
git add packages/plugins/convax-pet/package/manifest.json packages/plugins/convax-pet/package.json registry/config.json
git commit -m "chore(plugin): prepare convax pet 0.2.2"
```

## Task 8: Full Verification, Desktop Acceptance, and Publication

**Files:**
- Verify both repositories without unrelated edits.

- [ ] **Step 1: Run Convax focused and package checks**

Run from `/Users/bytedance/src/convax`:

```bash
bun test packages/desktop/src/main/pet-window.test.ts packages/desktop/src/main/agent-activity-controller.test.ts packages/desktop/src/main/pet-ipc.test.ts packages/desktop/src/main/pet-activity-notifier.test.ts packages/desktop/src/renderer/agent-panel-state.test.ts packages/desktop/src/renderer/agent-panel.test.tsx
bun run --cwd packages/desktop typecheck
bun run --cwd packages/desktop build
bun check
```

Expected: all commands exit zero.

- [ ] **Step 2: Run the complete Plugin repository contract**

Run from `/Users/bytedance/src/convax-plugins`:

```bash
bun install --frozen-lockfile --ignore-scripts
bun run build
bun run validate
bun run build:companions
bun test
bun run pack
bun run build:index
```

Expected: every command exits zero and the generated Pet ZIP contains Plugin
Web bytes only.

- [ ] **Step 3: Run desktop built acceptance**

Run:

```bash
bun run --cwd packages/desktop smoke:open-project
```

Then verify on macOS:

1. wake in a full-screen Convax Space;
2. finish a visible turn and observe `Ready` clear;
3. background Convax, finish another turn, and observe one native notification;
4. click the notification and verify exact-session navigation;
5. drag rapidly and across a display boundary;
6. expand/collapse the tray repeatedly with a stable pet anchor.

- [ ] **Step 4: Inspect final diffs and working trees**

Run in both repositories:

```bash
git diff --check
git status --short --branch
git log --oneline --decorate -8
```

Expected: only the intended committed changes remain.

- [ ] **Step 5: Push both branches and open/update review**

```bash
git push origin codex/convax-pet
```

Push from each repository. Open or update the Convax Host pull request and the
Plugin release pull request. Do not merge until protected CI succeeds.

- [ ] **Step 6: Publish Plugin `0.2.2` through the protected workflow**

After the Plugin PR is merged and CI is green, create and push the annotated
tag:

```bash
git tag -a plugin-convax-pet-v0.2.2 -m "Convax Pet 0.2.2"
git push origin plugin-convax-pet-v0.2.2
```

Confirm the protected release workflow publishes the ZIP, checksums, Registry
index, and GitHub Release, then verify the public Registry reports the new
version and sequence. If the Host PR is not yet available to users, release
notes must explicitly state the minimum compatible Convax build.
