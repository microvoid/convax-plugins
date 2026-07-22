# Convax Pet Plugin Design

**Date:** 2026-07-22  
**Status:** Approved design  
**Packages:** `packages/plugins/convax-pet` in `convax-plugins`; generic pet and activity support in `@convax/agent-runtime` and `@convax/desktop` in `/Users/bytedance/src/convax`  
**External tools:** None

## 1. Summary

Add a Codex-style floating desktop pet to Convax without turning the Plugin ZIP
into executable application code.

The first pet is an original character named **Violet**. The Plugin contributes
only a manifest, license information, and a local sprite atlas. Convax owns the
trusted behavior: aggregating agent activity across all projects, selecting the
highest-priority activity, rendering a transparent always-on-top window,
navigating to a selected session, persisting preferences, and enforcing the
security boundary.

This split preserves the existing Convax Plugin architecture:

- Plugin packages remain inert, offline assets.
- Host capabilities are generic and keyed by contribution type, never by the
  `convax-pet` package ID.
- No executable, server, native binary, dependency tree, or install hook is
  included in the Plugin ZIP.
- The design is visually consistent with Convax and behaviorally similar to the
  documented Codex pet, without copying Codex source code or character assets.

## 2. Goals

1. Provide a floating, optional desktop companion that reflects activity from
   every open or known Convax project and agent session.
2. Match the useful Codex pet semantics: running, needs-input, ready, blocked,
   persistent selection and position, direct navigation, custom pet import, and
   reduced-motion behavior.
3. Extend the Plugin contract with a strict, declarative `contributes.pet`
   contribution.
4. Keep all security-sensitive and stateful behavior in trusted Convax code.
5. Reuse Convax's theme, spacing, typography, agent runtime, preferences,
   project routing, and Electron lifecycle patterns.

## 3. Non-goals

- Copying Codex implementation code, private Convax implementation into this
  repository, or existing copyrighted pet artwork.
- Running arbitrary HTML, JavaScript, Electron, Node.js, or a companion process
  from a pet Plugin.
- Exposing message bodies, prompts, project paths, tool arguments, permission
  contents, or question contents to the pet renderer.
- Adding a pet that exists only inside a Canvas iframe.
- Automatically showing a pet immediately after package installation.
- Adding network-backed pet resources or a pet marketplace downloader.

## 4. Research Findings

### 4.1 Codex pet behavior

OpenAI's documented pet behavior establishes the product reference:

- Pets float above other apps and may be selected, woken, or tucked away.
- Selection and window position persist.
- The visible states are Running, Needs input, Ready, and Blocked.
- State priority is Needs input, Blocked, Ready, then Running.
- Clicking the pet returns to the relevant activity.
- Reduced motion displays a still frame.
- Custom pets remain local.

The documented custom pet format is a transparent PNG or WebP sprite atlas at
1536 by 1872 pixels, no larger than 20 MiB. Public Codex pet tooling shows an
8-column by 9-row atlas with 192 by 208 pixel cells and animation rows for idle,
directional movement, waving, jumping, failure, waiting, running, and review.

References:

- [OpenAI Academy: Pets](https://learn.chatgpt.com/docs/pets)
- [OpenAI Codex documentation](https://developers.openai.com/codex/)
- [Public Codex pet atlas constants](https://github.com/backnotprop/codex-pets-react/blob/main/src/lib/atlas.ts)

These sources inform behavior and file compatibility only. Violet is an original
asset and Convax uses its own UI and host architecture.

### 4.2 `convax-plugins` architecture

The repository packages static Plugin content as inert bytes. The contents of a
workspace's `package/` directory become the ZIP root. Published metadata and
bytes are validated, packed deterministically, indexed in the Registry, and
versioned with package SemVer plus the Registry sequence.

Existing Plugin versions are matched to versioned host protocols. The current
public repository supports `convax.plugin/1` through `convax.plugin/4`, while
Convax `convax-next` already implements `convax.plugin/5` with the independently
versioned `convax.plugin-capability/1` contract. The public repository must first
adopt that existing v5 contract, then add `contributes.pet` as an optional,
non-executable v5 contribution without narrowing or replacing the other v5
capabilities.

### 4.3 Convax host architecture

The referenced `/Users/bytedance/src/convax` repository separates ownership as
follows:

- `@convax/agent-runtime` owns generic agent sessions, messages, permissions,
  questions, busy/retry status, prompts, and cancellation.
- `@convax/ui` owns shared visual primitives and theme tokens.
- `@convax/desktop` owns Electron composition, IPC, preferences, project
  navigation, native windows, and process lifecycle.
- Plugin routing is contribution-based and must not special-case package IDs.

The current Canvas Plugin host is intentionally scoped to a project/canvas/node
context. Its agent prompt method starts a session for that context. It does not
provide a trusted, cross-project activity stream or permission to create a native
desktop overlay. A Canvas iframe therefore cannot safely implement the requested
experience.

The correct boundary is a host-owned overlay driven by a generic declarative pet
contribution.

## 5. Considered Approaches

### 5.1 Declarative pet Plugin plus host-owned overlay — selected

The Plugin contributes static metadata and a sprite atlas. Convax owns all
runtime behavior and native UI.

Advantages:

- Matches the repository's inert Plugin model.
- Keeps Electron, filesystem, navigation, and agent state behind trusted IPC.
- Supports third-party pets without package-ID special cases.
- Reuses existing Convax lifecycle and theme ownership.

### 5.2 Plugin-owned Web overlay

A Plugin iframe could render the pet, but the host would still need to expose
cross-project activity, native-window control, focus/navigation, display
positioning, and persistence. That would create an unnecessarily broad and
difficult-to-secure API surface.

### 5.3 Sidecar executable

A companion executable could independently create a window, but it would add a
second process, IPC authentication, installation, updates, and platform-specific
packaging. It conflicts with the desired Plugin architecture and is unnecessary.

## 6. Architecture

```text
packages/plugins/convax-pet
  manifest + license + Violet sprite atlas
              |
              | convax.plugin/5 contributes.pet
              v
Convax Plugin registry/installer
  schema, path, image, digest and lifecycle validation
              |
              v
Desktop Pet Controller <---- Agent Activity Controller
  selection/state               all projects/sessions
  window lifecycle              priority/read state
  persistence                   bounded snapshots
       |                              |
       v                              v
Sandboxed pet renderer       project/session navigation
  sprite animation only      resolved in trusted main process
```

### 6.1 Plugin contribution

The initial source manifest is:

```json
{
  "schema": "convax.plugin/5",
  "id": "convax-pet",
  "name": "Convax Pet",
  "version": "0.1.0",
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

The final manifest follows the exact field layout established by the new schema.
The schema is strict: unknown keys are rejected rather than silently ignored.

`spriteVersion: 2` denotes the 8 by 9 atlas layout defined in section 7. The
contract is generic so any valid Plugin can contribute a pet.

### 6.2 Protocol ownership

- `convax.plugin/5` describes installable Plugin metadata and contributions,
  including existing project-wide Canvas, LLM, and owned-Skill declarations plus
  the new optional pet declaration.
- `convax.plugin-capability/1` remains an independently versioned host capability
  contract.
- A pet contribution does not receive Canvas capabilities or a MessagePort.
- Host and repository keep shared valid/invalid fixtures to detect schema drift;
  existing v5 fixtures remain valid after the pet field is added.
- Older Plugin versions continue to install and run unchanged.

### 6.3 Trusted host components

`@convax/agent-runtime` exposes a bounded, content-free activity summary. It does
not know about Electron windows or pet animations.

`@convax/desktop` adds:

- `AgentActivityController`: aggregates project/session activity, computes
  priority and unread state, and emits monotonically revisioned snapshots.
- `PetController`: resolves the selected contribution, maps activity to
  animation, owns wake/tuck state, and manages the overlay lifecycle.
- `PetWindow`: creates the hardened transparent BrowserWindow, validates IPC,
  and clamps display position.
- Preferences and settings integration for pet selection and custom imports.

The pet renderer receives only presentation-ready state and opaque activity IDs.

## 7. Sprite Contract and Violet Art Direction

### 7.1 Atlas format

- PNG or WebP.
- Exactly 1536 by 1872 pixels.
- 8 columns and 9 rows.
- Cell size: 192 by 208 pixels.
- Contains an alpha channel and at least one transparent pixel.
- Maximum file size: 20 MiB.
- Rendered with pixelated image sampling.

Animation rows:

| Row | Animation | Frames | Frame durations in milliseconds |
| --- | --- | ---: | --- |
| 0 | idle | 6 | 280, 110, 110, 140, 140, 320 |
| 1 | running-right | 8 | 120, 120, 120, 120, 120, 120, 120, 220 |
| 2 | running-left | 8 | 120, 120, 120, 120, 120, 120, 120, 220 |
| 3 | waving | 4 | 140, 140, 140, 280 |
| 4 | jumping | 5 | 140, 140, 140, 140, 280 |
| 5 | failed | 8 | 140, 140, 140, 140, 140, 140, 140, 240 |
| 6 | waiting | 6 | 150, 150, 150, 150, 150, 260 |
| 7 | running | 6 | 120, 120, 120, 120, 120, 220 |
| 8 | review | 6 | 150, 150, 150, 150, 150, 280 |

Unused cells remain fully transparent.

### 7.2 Violet

Violet is an original, small purple pixel companion. The silhouette must remain
legible around 96 by 104 rendered pixels, with restrained highlights and a clear
face/gesture language. It may use Convax purple as an accent but must not copy a
Codex pet character, pose sheet, logo, or other third-party asset.

All source and generated asset licensing must be recorded in the package.

## 8. Activity State Model

The activity summary has five presentation states:

| State | Source condition | Animation |
| --- | --- | --- |
| `needs-input` | Pending permission or question | `review` for permission, `waiting` for question |
| `blocked` | Terminal agent, tool, or system error | `failed` |
| `ready` | Successful completion not yet viewed | `waving` |
| `running` | Busy, retry, or known in-flight prompt | `running` |
| `idle` | No unread or active work | `idle` |

Priority is exact and global:

```text
needs-input > blocked > ready > running > idle
```

Activities with the same priority are ordered by most recent meaningful update.
Retry remains `running`. User-initiated cancellation becomes `idle`, not
`blocked`.

### 8.1 Aggregation

- Aggregate every known project and session, not only the selected Canvas.
- On startup, enumerate projects and recover active, waiting, and unread sessions.
- Route normal prompt, abort, permission, and question flows through the activity
  controller so steady-state changes do not require permanent idle polling.
- Poll only active or externally recoverable sessions with bounded intervals;
  use backoff when the runtime is unavailable.
- Every published snapshot carries a monotonic revision. Consumers discard older
  revisions and delayed poll results.
- Bound the number of retained activities and read watermarks.

### 8.2 Privacy boundary

A renderer snapshot may contain:

- opaque activity ID;
- opaque project and session IDs;
- user-visible project/session label already approved for navigation UI;
- presentation status and subtype;
- update timestamp and revision.

It must not contain message text, prompts, answers, filesystem paths, tool names
or parameters, permission details, question contents, environment values, or
credentials.

Clicking an activity returns its opaque ID to the main process. The main process
resolves and validates the current target before asking the main Convax renderer
to navigate.

### 8.3 Read semantics

Opening the pet tray does not mark an activity read. A `ready` or `blocked`
activity is marked read only after its destination session has actually been
displayed by Convax. Watermarks are bounded and persisted without conversation
content.

## 9. Interaction and Visual Design

### 9.1 Lifecycle

- Installing a pet does not automatically show it.
- The user selects a pet and explicitly wakes it from Convax settings or the pet
  control.
- `/pet` parity is an interaction goal, but command-palette syntax is optional for
  the first release if Convax has no existing slash-command owner.
- Tucking a pet closes the overlay while preserving selection and position.
- Uninstalling the selected pet closes the overlay and clears that selection; the
  host does not silently substitute another pet.

### 9.2 Window states

- Collapsed overlay: approximately 176 by 176 logical pixels, containing the pet,
  a small status dot, and a compact status pill.
- Expanded tray: approximately 356 by 320 logical pixels, containing at most four
  visible activity rows with scrolling for additional rows.
- The window is transparent, frameless, excluded from the taskbar, and above
  normal application windows.
- It never steals focus merely because status changes.
- Dragging begins after a 4-pixel threshold and clamps the pet to a usable area of
  the current display.
- Horizontal dragging may use the directional running rows.

Clicking the pet briefly plays `jumping`, then focuses Convax and opens the
highest-priority activity. Clicking the status pill toggles the tray. Clicking a
tray row navigates to that specific activity.

### 9.3 Existing Convax style

Use Convax UI primitives and current theme tokens, including:

- 6-pixel radius;
- light background `#f7f8f7` and card `#ffffff`;
- foreground `#171a18` and muted foreground `#68716c`;
- border `#d9ddda`;
- primary purple `#7657e8`;
- destructive `#c43d49`;
- Inter typography.

Status colors are secondary cues:

- running: primary purple;
- needs input: amber;
- ready: green;
- blocked: destructive red.

Every state also has text and animation semantics, so meaning never depends on
color alone.

### 9.4 Accessibility

- Reduced-motion mode displays a representative still frame and does not run an
  animation timer.
- The collapsed pet does not enter the tab order unless explicitly focused.
- The expanded tray supports keyboard navigation, activation, dismissal, and
  accessible labels.
- Alternative text comes from the validated contribution manifest.
- Announcements are limited to meaningful state changes and must not repeatedly
  announce polling refreshes.

## 10. Persistence

Persist a versioned, atomic `pet-state-v1` record through Convax's preference
owner. It contains:

- selected installed pet identity and version-safe reference;
- awake/tucked state;
- last valid position per display identity and scale context;
- bounded activity read watermarks;
- reduced-motion preference only if Convax does not already expose it globally.

It contains no chat content, project path, tool parameters, or custom asset source
path.

On display changes, resume, or DPI changes, revalidate and clamp the position. On
corrupt persistence, fall back to tucked state and default positioning without
deleting installed pet data.

## 11. Custom Pet Import

The settings UI provides selection, preview, wake/tuck, import, and deletion.

Import flow:

1. Copy the candidate to a private staging directory.
2. Validate path, byte size, file signature, decode, dimensions, alpha channel,
   and atlas contract.
3. Generate a stable internal identity and atomically move the validated asset to
   private application storage.
4. Store only the internal identity in preferences; never expose or retain the
   original source path in renderer state.
5. On failure, remove staging data and leave the current selection unchanged.

Custom pets are local and are never uploaded by this feature.

## 12. Security Model

### 12.1 Installation validation

Both repository validation and the Convax installer enforce:

- a version-matched strict manifest;
- relative, normalized resource paths within the package;
- no URL, absolute path, traversal, symlink, reserved name, or missing file;
- PNG/WebP signature, decodability, dimensions, alpha, and size limits;
- no executable, script entry, remote hook, companion declaration, or dependency
  tree for a pet-only Plugin;
- digest and Registry metadata integrity.

Updates are staged and committed atomically. A failed update preserves the
previous installed version. Released byte or catalog changes require a SemVer
bump; catalog publication also increments the Registry sequence.

### 12.2 Overlay hardening

The BrowserWindow uses:

```text
contextIsolation: true
sandbox: true
nodeIntegration: false
frame: false
transparent: true
```

Its fixed preload exposes only the minimal pet operations. The host blocks
navigation, popups, downloads, permission requests, remote resources, arbitrary
IPC channels, and untrusted senders. Content Security Policy permits only bundled
local UI and the validated local sprite image.

The renderer cannot read arbitrary files, create windows, access agent runtime
objects, or resolve activity IDs.

## 13. Failure Handling

- Runtime unavailable: show one generic system `blocked` activity, retry with
  bounded backoff, and do not expose internal error data.
- Temporarily unavailable project: show a generic unavailable label; remove the
  activity if the project is confirmed deleted.
- Sprite decode failure after installation: mark the contribution invalid and
  close the overlay rather than rendering a broken or remote fallback.
- Overlay renderer crash: recreate once; on repeated failure tuck the pet and
  leave Convax usable.
- Stale activity response: discard by revision and per-session update token.
- Display removal, resume, or scale change: move the overlay to a valid visible
  location.
- Application quit: stop timers, reject new overlay IPC, persist atomically, and
  close without blocking shutdown.
- Update or uninstall: close users of the old asset before replacing or deleting
  it.

## 14. Testing Strategy

### 14.1 `convax-plugins`

Schema and validator tests cover:

- valid pet-only `convax.plugin/5` manifests;
- schema/protocol mismatch and unknown fields;
- missing resource, traversal, absolute path, URL, symlink, and unsafe names;
- wrong extension, signature, dimensions, transparency, or byte size;
- executable content, runtime entry, companion, scripts, or install hooks;
- deterministic ZIP layout with `package/` contents at its root;
- package version and Registry sequence expectations;
- shared host/repository contract fixtures.

The real `convax-pet` package runs its trusted asset validation/build, package
tests, validation, packing, and Registry index generation.

### 14.2 Agent runtime and activity controller

Unit tests with fake clocks and fake session repositories cover:

- every source-to-presentation state mapping;
- exact priority and timestamp tie-breaking;
- retry and user cancellation semantics;
- unread completion and mark-seen behavior;
- multiple projects and sessions;
- startup recovery, project removal, runtime failure, and backoff;
- stale poll/revision rejection;
- bounded retention and absence of sensitive content.

### 14.3 Desktop main process

Tests cover:

- hardened BrowserWindow options and fixed preload surface;
- sender validation, opaque activity resolution, and navigation integrity;
- CSP, navigation, popup, download, permission, and remote-resource blocking;
- position clamping across multi-display, scale, resume, and display removal;
- awake state and position persistence;
- overlay crash recovery;
- update, uninstall, invalid sprite, and shutdown lifecycle.

### 14.4 Renderer and accessibility

Tests cover:

- selection, preview, wake/tuck, import, and delete controls;
- collapsed/expanded interactions and activity scrolling;
- drag-versus-click threshold;
- animation row/frame/duration mapping;
- reduced motion with no animation timer;
- keyboard navigation, labels, focus behavior, and non-color status cues;
- navigation followed by confirmed mark-seen behavior.

### 14.5 End-to-end acceptance

Use two projects and multiple sessions to verify:

1. Explicitly waking Violet starts in idle.
2. A prompt in project A selects running.
3. A permission in project B immediately preempts with needs-input.
4. Answering it returns to the next highest-priority activity.
5. An unseen successful completion selects ready.
6. Clicking the pet focuses Convax and opens the correct project/session.
7. The activity becomes read only after the session is displayed.
8. A terminal failure selects blocked; user cancellation does not.
9. Restart restores selection, awake state, and valid display position.
10. Update preserves selection; uninstall safely closes and clears it.
11. Valid custom import succeeds; invalid and malicious inputs are rejected.
12. Offline operation produces no network request.

## 15. Required Verification

In `convax-plugins`, after the explicit trusted workspace build phases:

```sh
bun install --frozen-lockfile --ignore-scripts
bun run validate
bun run workspaces:typecheck
bun run workspaces:test
bun run build:companions
bun test
bun run pack
bun run build:index
```

Run any repository-defined trusted Plugin/Skill build commands before validation
and packing, as required by the contributor contract.

In `/Users/bytedance/src/convax`:

- run targeted typecheck and tests for `@convax/agent-runtime` and desktop;
- run the desktop build;
- run root `bun check` because the change crosses IPC, protocol, persistence, and
  package boundaries;
- run the repository's built desktop open-project smoke test;
- perform a manual multi-display and reduced-motion smoke test for native window
  behavior that unit tests cannot fully represent.

## 16. Expected Change Areas

The implementation plan will resolve exact filenames before editing, but the
expected ownership is:

### `convax-plugins`

- `packages/plugins/convax-pet/`: manifest workspace, package assets, license,
  tests, and trusted asset checks.
- manifest/schema types and validators: add strict `contributes.pet` and
  `convax.plugin/5` support.
- packer and Registry tooling: recognize and publish the new version without
  executing package content.
- Registry catalog/config: add `convax-pet` and increment the sequence.
- authoring/Registry documentation: document the contribution and sprite
  contract.

### `/Users/bytedance/src/convax`

- agent runtime: content-free activity summary contract and implementation.
- desktop main/IPC/preload: activity controller, pet controller/window, validated
  navigation, persistence, import, and lifecycle.
- desktop renderer/settings: selection, preview, controls, and activity tray.
- Plugin contract/installer: version 5 and pet resource validation.
- tests and smoke coverage adjacent to each changed owner.

Exact file changes must follow each repository's local contributor instructions
and preserve unrelated user changes.

## 17. Acceptance Criteria

The feature is complete when:

- a valid `convax-pet` Plugin can be validated, packed, indexed, installed, and
  selected without executable Plugin content;
- Violet behaves according to the state, priority, interaction, persistence, and
  accessibility contracts above across all projects/sessions;
- no pet renderer or package can access sensitive activity content, arbitrary
  files, Node/Electron APIs, remote resources, or unrestricted IPC;
- invalid assets and lifecycle failures degrade safely without breaking Convax;
- host logic is generic and contains no `convax-pet` package-ID special case;
- the package artwork and UI are original and visually consistent with Convax;
- all required verification commands and end-to-end acceptance scenarios pass.
