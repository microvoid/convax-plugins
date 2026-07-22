# Convax Pet Feature Plugin Design

**Date:** 2026-07-22
**Status:** Proposed — section design approved; written review pending
**Plugin owner:** `packages/plugins/convax-pet` in `convax-plugins`
**Host owners:** generic pet platform support in `@convax/agent-runtime` and
`@convax/desktop` in `/Users/bytedance/src/convax`
**External tools:** None

## 1. Summary

Convax Pet is one installable feature Plugin that owns the complete pet product
experience. It renders the floating companion, maps Agent activity to animation,
provides the pet collection and settings UI, ships Violet, and imports multiple
legacy Codex pets such as `/Users/bytedance/Desktop/pets/goku`.

Convax remains a thin trusted host. It provides only operations that a sandboxed
Web Plugin cannot safely perform: creating a native transparent overlay, projecting
content-free Agent activity across projects, resolving session navigation, showing
native file dialogs, copying authorized assets into Plugin-private storage, and
persisting bounded Plugin state.

The key ownership rule is:

```text
One Pet feature Plugin owns many pets.
Pets are library data; individual pets are not separate Convax Plugins.
```

The current branch implementation instead makes each pet a declarative resource
Plugin and keeps most product behavior in Convax. This design supersedes that
boundary before release.

## 2. Goals

1. Make the complete pet experience installable, disableable, and uninstallable as
   one Convax Plugin.
2. Let that Plugin manage Violet, Goku, and any number of compatible local pets.
3. Support both a single legacy `pet.json` and batch import from a `pets` root
   directory.
4. Preserve Codex-style activity semantics, direct navigation, reduced motion,
   multi-display positioning, and Convax visual language.
5. Keep Electron, native paths, unrestricted filesystem access, Agent content, and
   navigation authority outside the Plugin sandbox.
6. Keep host behavior generic and contribution-driven, with no special case for the
   `convax-pet` package ID.

## 3. Non-goals

- Making Violet and Goku separate Convax Plugins.
- Giving Plugin code Node, Electron, arbitrary IPC, shell, network, or native path
  access.
- Loading remote scripts, remote pet assets, native binaries, a companion process,
  or an install hook from the Plugin ZIP.
- Exposing prompts, messages, question text, permission details, tool arguments,
  project paths, or credentials to the Plugin.
- Copying private Codex or Convax implementation code or third-party character art.
- Defining a network marketplace for pets in the first release.
- Supporting arbitrary legacy directory recursion; batch import scans exactly one
  directory level below the selected `pets` root.

## 4. Research and Current State

### 4.1 Codex-compatible pet data

The legacy data to preserve uses one directory per pet:

```text
pets/
  goku/
    pet.json
    spritesheet.webp
```

The manifest shape is:

```json
{
  "id": "goku",
  "displayName": "Goku",
  "description": "A compact desktop companion.",
  "spritesheetPath": "spritesheet.webp"
}
```

The sprite atlas is a transparent PNG or WebP, no larger than 20 MiB, exactly
1536 by 1872 pixels. It contains eight 192 by 208 cells across and nine animation
rows: `idle`, `running-right`, `running-left`, `waving`, `jumping`, `failed`,
`waiting`, `running`, and `review`.

References used for behavioral and file compatibility only:

- [OpenAI Academy: Pets](https://learn.chatgpt.com/docs/pets)
- [OpenAI Codex documentation](https://developers.openai.com/codex/)
- [Public Codex pet atlas constants](https://github.com/backnotprop/codex-pets-react/blob/main/src/lib/atlas.ts)

### 4.2 Convax Plugin constraints

A Convax Web Plugin is inert, offline package content. Its HTML, CSS, and
JavaScript run in a sandboxed renderer without Node or Electron. Native operations
must be exposed as versioned, contribution-scoped host methods. The Plugin ZIP
must not contain an executable, server, dependency tree, native binary, or install
hook.

The package remains independently validated, deterministically packed, and
published through the Registry. The contents of `package/` are the ZIP root.

### 4.3 Superseded implementation

The first implementation on `codex/convax-pet` has this shape:

```text
Convax host
  owns overlay UI, animation mapping, pet collection, import and preferences
       ^
       | reads one contributes.pet resource
       |
one Plugin per pet
  owns only name, description and one atlas
```

It also exposes a host-owned raw spritesheet import path. That is useful as a
prototype but does not make the pet product a Plugin and cannot preserve legacy
`pet.json` metadata. The implementation must be refactored rather than published
in that form.

## 5. Considered Approaches

### 5.1 Host-owned feature with one Plugin per pet

This is the current prototype. It has a small Plugin API, but product logic is
permanently built into Convax and every pet becomes a separately installed Plugin.
It does not meet the product ownership goal.

### 5.2 Thin host plus one feature Plugin — selected

Convax supplies native and security-sensitive primitives. One sandboxed Pet Plugin
owns the overlay renderer, animation rules, library, import interpretation, and
settings UI. This makes the feature genuinely installable while preserving the
existing trust boundary.

### 5.3 Fully privileged Plugin

Allowing a Plugin to create Electron windows, inspect sessions, and read the
filesystem directly would reduce host adapter code but would defeat the Convax
sandbox. It is rejected.

### 5.4 Sidecar executable

A companion process would add platform packaging, process supervision, executable
authorization, and a second IPC boundary without providing a meaningful product
benefit. It is rejected.

## 6. Architecture

```text
packages/plugins/convax-pet
  static overlay + settings bundles
  Violet atlas + pet library logic + legacy parser
                  |
                  | convax.plugin/5 contributes.pet
                  | convax.pet-host/1 scoped ports
                  v
Convax Desktop pet platform
  provider lifecycle + isolated BrowserWindow + settings mount
  activity projection + validated navigation
  native selection grants + private asset/state storage
                  |
                  v
@convax/agent-runtime and Electron
  projects/sessions             displays/windows/files
```

### 6.1 Ownership

The Pet Plugin owns:

- overlay HTML, CSS, JavaScript, and accessible interaction behavior;
- collapsed and expanded layouts;
- activity priority and state-to-animation mapping;
- sprite animation timing and reduced-motion presentation;
- pet collection, selection, descriptions, previews, and delete controls;
- Violet as the built-in default library entry;
- legacy manifest parsing and batch import result presentation;
- Plugin preferences that do not require native interpretation.

Convax owns:

- discovering and activating exactly one Pet contribution;
- the transparent, always-on-top, frameless BrowserWindow;
- isolated sessions, CSP, navigation blocking, crash recovery, and fixed preload;
- cross-project content-free Agent activity projection;
- resolving opaque activity IDs and opening the correct project/session;
- native file/directory selection and temporary import grants;
- image inspection and atomic Plugin-private asset publication;
- bounded, atomic Plugin-private state storage;
- window position, display identity, scale context, wake/tuck lifecycle, and app
  shutdown ordering.

Convax does not own Violet, animation rows, activity priority, pet cards, legacy
manifest semantics, or pet-specific copy.

### 6.2 Provider uniqueness

`contributes.pet` is a singleton feature contribution. At most one enabled Plugin
may own the Pet surface at a time. Installation may coexist with another disabled
provider, but activation must ask the user to replace the active provider rather
than allowing two Plugins to compete for one native overlay.

The rule is keyed by contribution type, never package ID. When no Pet provider is
enabled, Convax does not create the overlay, subscribe to global activity, or show
the Pet settings section.

## 7. Plugin Contract

### 7.1 Manifest

The revised `convax.plugin/5` contribution declares feature entry points, not one
pet asset:

```json
{
  "schema": "convax.plugin/5",
  "id": "convax-pet",
  "name": "Convax Pet",
  "description": "A local desktop companion and pet library for Convax activity.",
  "version": "0.2.0",
  "capabilities": [
    "pet.activity.read",
    "pet.activity.open",
    "pet.library.manage",
    "pet.preferences.write"
  ],
  "contributes": {
    "pet": {
      "overlay": "pet/index.html",
      "settings": "settings/index.html",
      "protocol": "convax.pet-host/1"
    }
  }
}
```

Paths are package-relative, case-sensitive, and must resolve to regular files.
Unknown fields and capabilities are rejected. A Pet feature package remains static
Web content; it may contain bundled JavaScript but no native runtime.

The current `name`, `description`, `spritesheet`, `spriteVersion`, and `alt` form is
removed before publication. Existing unrelated `convax.plugin/5` contributions
remain valid.

### 7.2 Pet host protocol

`convax.pet-host/1` is separate from Canvas host protocols. Convax transfers a
fresh MessagePort to each mounted Pet surface after verifying the installed Plugin,
manifest entry, document URL, renderer identity, and requested capabilities.

The overlay and settings surfaces receive different allowlists:

| Surface | Allowed operation groups |
| --- | --- |
| Overlay | activity snapshot/events, activity open, selected pet asset, presentation preferences, overlay move/expand |
| Settings | library snapshot/events, import selection/commit, select/delete, preferences, wake/tuck |

Neither surface can forward arbitrary method names. Requests and responses are
versioned, uniquely identified, size-bounded, schema-validated, and rejected after
the surface or Plugin generation changes.

### 7.3 Host method semantics

The protocol exposes narrow operations equivalent to:

```text
activity.getSnapshot / activity.changed
activity.open
overlay.move / overlay.setExpanded
library.getSnapshot / library.changed
library.selectLegacySource / library.commitLegacyImport
library.deleteImportedAsset
preferences.get / preferences.update
lifecycle.setAwake
```

Method names are part of the versioned contract; the implementation plan may group
request and event types differently without expanding their authority.

`activity.open` accepts only an opaque activity ID and the snapshot revision.
`preferences.update` accepts an exact bounded schema, not arbitrary filesystem or
application settings. Asset responses use opaque Plugin-scoped URLs and never
native paths.

## 8. Pet Library

### 8.1 Data model

The Plugin maintains a `convax.pet-library/1` record:

```json
{
  "schema": "convax.pet-library/1",
  "selectedId": "goku",
  "pets": [
    {
      "id": "goku",
      "displayName": "Goku",
      "description": "A compact desktop companion.",
      "assetId": "sha256:...",
      "sha256": "...",
      "source": "legacy-import"
    }
  ]
}
```

Built-in entries use package asset URLs and `source: "built-in"`. Imported entries
use opaque IDs allocated by Convax. Library metadata is stored through bounded,
atomic Plugin-private preferences. Imported bytes live in a separate Plugin-private
asset root.

Violet is always recoverable from immutable package bytes. Corrupt imported entries
are isolated without resetting the rest of the library.

### 8.2 Legacy selection

The settings surface offers one “Import legacy pets” action with both modes:

- select one `pet.json`;
- select a `pets` root and scan each immediate child for `pet.json`.

The Plugin never receives native paths. Convax issues a short-lived, Plugin-bound
selection grant containing bounded candidate IDs, manifest text, safe relative
filenames, and inspected image facts. The grant expires on timeout, Plugin reload,
cancel, or commit.

### 8.3 Parsing and validation

The Plugin parses the exact legacy keys `id`, `displayName`, `description`, and
`spritesheetPath`. It rejects unknown keys, invalid identifiers, unsafe relative
paths, missing fields, and unsupported formats.

Before publishing any asset, Convax independently enforces:

- the selected manifest and image remain within the authorized candidate;
- neither component is a symlink or non-regular file;
- the path has no traversal, absolute segment, reserved name, or case ambiguity;
- bytes are a real PNG or WebP matching the extension;
- dimensions are exactly 1536 by 1872;
- an alpha channel and useful transparency are present;
- size does not exceed 20 MiB;
- the bytes have not changed since grant inspection.

Plugin validation improves error messages but never substitutes for host
validation.

### 8.4 Commit behavior

Each valid candidate is committed atomically. Batch import is not all-or-nothing:
valid pets succeed, invalid pets are skipped, and the settings surface presents a
summary for every candidate.

An existing ID is updated only after the replacement asset is fully validated and
published. Identical content is deduplicated by SHA-256. Failed or canceled imports
leave the current library and selection unchanged. Temporary grants and staged
bytes are always removed.

After a successful import, the newest successfully imported pet becomes selected.
Import never wakes a tucked overlay automatically.

## 9. Activity and Presentation

### 9.1 Host activity projection

Convax aggregates every known project and session and emits bounded,
monotonically-revisioned activity snapshots. It may use event routing, bounded
recovery polling, global fairness, and backoff internally. The Plugin receives only:

- opaque activity ID;
- opaque project and session identity required for freshness checks;
- already-approved user-visible project/session labels;
- normalized state and subtype;
- update timestamp and snapshot revision.

It never receives prompts, messages, question or permission content, tool details,
paths, environment values, or credentials.

### 9.2 Plugin presentation rules

The Plugin applies exact global priority:

```text
needs-input > blocked > ready > running > idle
```

Default mappings are:

| Activity | Animation |
| --- | --- |
| Pending question | `waiting` |
| Pending permission | `review` |
| Blocked or terminal error | `failed` |
| Successful completion not yet displayed | `waving` |
| Busy, retry, or in-flight prompt | `running` |
| No visible activity | `idle` |

Same-priority activities are ordered by most recent meaningful update. User
cancellation becomes idle, not blocked. Clicking the pet briefly plays `jumping`
before requesting navigation to the selected activity.

### 9.3 Window and accessibility

- Collapsed surface: approximately 176 by 176 logical pixels.
- Expanded tray: approximately 356 by 320 logical pixels with scrolling beyond
  four visible activity rows.
- Drag begins after four logical pixels and may use directional running rows.
- The window never steals focus merely because activity changed.
- Reduced motion fixes each state to a representative still frame and creates no
  animation timer.
- Expanded controls support keyboard navigation, activation, dismissal, labels,
  and non-color status cues.
- The Plugin uses current Convax theme tokens, typography, spacing, and six-pixel
  corner radius rather than reproducing Codex styling literally.

## 10. Lifecycle and Persistence

Installing the Plugin does not wake the pet. Enabling it mounts the settings
surface and prepares the provider. The user explicitly selects a pet and wakes the
overlay.

Convax persists native lifecycle data separately from Plugin product data:

- awake/tucked state;
- last valid position per display ID and scale context;
- active provider identity and generation;
- bounded navigation/read acknowledgements where host validation requires them.

The Plugin persists library selection and presentation preferences through its
private store. No record contains source paths or Agent content.

Disabling or uninstalling the provider closes the overlay, stops global activity
projection, revokes ports and grants, and removes the Pet settings surface. Imported
pet data remains inert in Plugin-private storage so reinstall can restore it. A
future explicit “remove Plugin data” operation may delete it; ordinary uninstall
does not silently destroy user-imported pets.

Updates stage new package bytes before revoking the old generation. State is
reconnected only after the new manifest and entry points validate. A failed update
preserves the previous installed Plugin and library.

## 11. Security Model

The overlay BrowserWindow uses:

```text
contextIsolation: true
sandbox: true
nodeIntegration: false
frame: false
transparent: true
```

It uses a nonpersistent, Plugin-scoped Electron session. The custom asset protocol
is registered and removed on that same session. Convax blocks navigation, popups,
downloads, permission requests, remote resources, service workers, and untrusted
senders. CSP permits only the installed Plugin bundle and validated Plugin-private
pet assets.

The fixed preload transfers only the surface-specific `convax.pet-host/1` port. It
does not expose Electron APIs, native paths, a generic IPC method, or unrestricted
fetch. Every asynchronous result is bound to the provider and document generation
that requested it.

Installation and packing remain inert. Repository validation may inspect asset
bytes but never executes contributor package scripts during validation or packing.

## 12. Failure Handling

- Invalid legacy candidate: skip it and show a bounded, actionable reason.
- Partial batch failure: keep successful imports and summarize failures.
- Runtime temporarily unavailable: publish a generic unavailable activity and
  retry with bounded backoff without leaking diagnostics.
- Stale activity or navigation revision: reject the action and let the Plugin
  refresh its snapshot.
- Overlay renderer crash: recreate once; a second crash tucks the pet and leaves
  Convax usable.
- Settings renderer crash: discard its port and remount through the normal Plugin
  surface lifecycle.
- Sprite failure after import: quarantine that entry and retain the rest of the
  library.
- Corrupt Plugin preferences: restore Violet and safe defaults without deleting
  imported bytes.
- Display removal, resume, or scale change: clamp the overlay to a visible work
  area, preferring the last display identity.
- App shutdown: reject new requests, revoke grants, persist atomically, stop
  activity work, and close without blocking shutdown.

## 13. Testing Strategy

### 13.1 `convax-plugins`

Schema, validator, packer, and Registry tests cover:

- a valid Pet feature Plugin with both static entry points;
- capability and protocol mismatch, missing entry, unknown field, unsafe path,
  symlink, remote resource, executable, companion, and install hook rejection;
- retention of unrelated `convax.plugin/5` contributions;
- deterministic ZIP layout and Registry metadata;
- package SemVer and Registry sequence requirements.

Pet Plugin workspace tests cover:

- exact single and batch legacy parsing;
- duplicate IDs, identical-content deduplication, replacement, and partial failure;
- activity priority and animation mappings;
- library selection, delete, corruption recovery, and preference migration;
- overlay interactions, reduced motion, scrolling, keyboard behavior, and labels;
- disconnected and rejected host requests.

### 13.2 Convax host

Host tests cover:

- singleton provider activation without package-ID special cases;
- per-surface protocol allowlists, identity validation, generation revocation, and
  bounded messages;
- isolated session protocol registration and navigation hardening;
- content-free, fair, bounded cross-project activity projection;
- opaque navigation resolution and stale revision rejection;
- single-file and one-level directory selection grants;
- symlink, traversal, file replacement, signature, dimension, alpha, and size
  rejection at commit time;
- atomic asset publication, deduplication, retained data, and cleanup;
- wake/tuck, multi-display restore, crash recovery, update, uninstall, and shutdown.

### 13.3 End-to-end acceptance

1. Install and enable Convax Pet; the settings surface appears but the overlay
   remains tucked.
2. Wake bundled Violet and verify idle rendering.
3. Select `/Users/bytedance/Desktop/pets/goku/pet.json`; Goku imports with its name,
   description, and atlas.
4. Select `/Users/bytedance/Desktop/pets`; valid immediate children import in one
   batch and invalid children appear in the summary.
5. Re-import identical Goku bytes without creating a duplicate.
6. Start work in project A and request input in project B; the Plugin applies the
   documented priority.
7. Click the active row; Convax focuses and opens the correct project/session.
8. Enable reduced motion and verify no animation timer runs.
9. Restart and restore the selected pet, library, wake state, and visible display
   position.
10. Disable or uninstall the Plugin; the overlay and activity subscription stop.
11. Reinstall and recover imported pets from inert private storage.
12. Perform the complete flow offline with no remote request.

## 14. Migration from the Prototype

Because the current Pet contract has not been published, migration replaces it
before release rather than supporting two public models.

### `convax-plugins`

- Replace the one-pet manifest fields with feature `overlay`, `settings`, and
  `protocol` entries.
- Move Violet into the Plugin-owned library and add bundled static Web surfaces.
- Move animation, priority, collection, import interpretation, and settings tests
  into the Plugin workspace.
- Update schema, authoring, packaging, Registry documentation, tests, version, and
  Registry sequence.

### `/Users/bytedance/src/convax`

- Keep and generalize the secure window, activity projection, navigation,
  persistence, asset inspection, and lifecycle foundations.
- Replace host-owned pet React UI and product controller logic with provider
  activation, surface mounting, protocol ports, selection grants, and private
  storage adapters.
- Remove raw spritesheet import and the assumption that installed Plugins each
  contribute one selectable pet.
- Preserve the already-tested fairness, stale-result handling, multi-display
  recovery, isolated session, and sandboxed preload behavior.

No unrelated application or Plugin architecture is refactored.

## 15. Required Verification

In `convax-plugins`:

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

In `/Users/bytedance/src/convax`:

- run affected package typechecks and focused tests;
- run the complete root `bun run check`;
- run the built Electron open-project and Plugin smoke path;
- manually verify native multi-display drag/restore and reduced motion where
  automated Electron coverage cannot prove OS behavior.

## 16. Acceptance Criteria

The revision is complete when:

- installing one Convax Pet Plugin provides the overlay, settings, Violet, pet
  library, and legacy import experience;
- Goku imports from the supplied old format without becoming a separate Convax
  Plugin;
- selecting a `pets` root imports valid immediate children and reports invalid
  ones independently;
- disabling or uninstalling the feature Plugin removes the running feature while
  preserving inert imported user data;
- Convax contains only generic native/security primitives and no Violet, pet card,
  animation mapping, or package-ID special case;
- Plugin code cannot access Agent content, native paths, unrestricted files,
  Node/Electron, network, or arbitrary IPC;
- all repository, host, integration, accessibility, lifecycle, and security tests
  pass.
