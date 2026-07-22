# Convax Pet Feature Plugin Design

**Date:** 2026-07-22
**Status:** Approved
**Plugin owner:** `packages/plugins/convax-pet` in `convax-plugins`
**Host owners:** generic pet platform support in `@convax/agent-runtime` and
`@convax/desktop` in `/Users/bytedance/src/convax`
**External tools:** None

## 1. Summary

Convax Pet is one installable feature Plugin that owns the complete pet product
experience. It renders the floating companion, maps Agent activity to animation,
provides the pet collection and settings UI, and ships an internal pet library
whose first member is Violet.

Convax remains a thin trusted host. It provides only operations that a sandboxed
Web Plugin cannot safely perform: creating a native transparent overlay, projecting
content-free Agent activity across projects, resolving session navigation, serving
installed Plugin assets, and persisting bounded Plugin and window state.

The key ownership rule is:

```text
One Pet feature Plugin owns many pets.
Pets are packaged library data; individual pets are not separate Convax Plugins.
```

The current branch implementation instead makes each pet a declarative resource
Plugin and keeps most product behavior in Convax. This design supersedes that
boundary before release.

## 2. Goals

1. Make the complete pet experience installable, disableable, and uninstallable as
   one Convax Plugin.
2. Let the Plugin own a versioned library containing Violet initially and more
   bundled pets in future Plugin releases.
3. Preserve Codex-style activity semantics, direct navigation, reduced motion,
   multi-display positioning, and Convax visual language.
4. Keep Electron, native paths, unrestricted filesystem access, Agent content, and
   navigation authority outside the Plugin sandbox.
5. Keep host behavior generic and contribution-driven, with no special case for the
   `convax-pet` package ID.

## 3. Non-goals

- Making Violet or any other character a separate Convax Plugin.
- Importing Goku, legacy `pet.json`, a `pets` directory, or a raw spritesheet.
- Adding a user-authored pet format or local pet editor in the first release.
- Giving Plugin code Node, Electron, arbitrary IPC, shell, network, or native path
  access.
- Loading remote scripts, remote pet assets, native binaries, a companion process,
  or an install hook from the Plugin ZIP.
- Exposing prompts, messages, question text, permission details, tool arguments,
  project paths, or credentials to the Plugin.
- Copying private Codex or Convax implementation code or third-party character art.
- Defining a network marketplace for pets in the first release.

## 4. Research and Current State

### 4.1 Codex-compatible behavior and atlas

The product reference is an optional desktop companion that reflects Running,
Needs input, Ready, and Blocked activity, persists its selection and position,
opens the relevant activity when clicked, and displays a still frame when reduced
motion is enabled.

The sprite contract used by the bundled library is a transparent PNG or WebP, no
larger than 20 MiB, exactly 1536 by 1872 pixels. It contains eight 192 by 208 cells
across and nine animation rows: `idle`, `running-right`, `running-left`, `waving`,
`jumping`, `failed`, `waiting`, `running`, and `review`.

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
  owns overlay UI, animation mapping, pet collection and preferences
       ^
       | reads one contributes.pet resource
       |
one Plugin per pet
  owns only name, description and one atlas
```

It also exposes a host-owned raw spritesheet import path. That prototype does not
make the pet product a Plugin and is outside the revised scope. Both behaviors must
be refactored before publication.

## 5. Considered Approaches

### 5.1 Host-owned feature with one Plugin per pet

This is the current prototype. It has a small Plugin API, but product logic is
permanently built into Convax and every pet becomes a separately installed Plugin.
It does not meet the product ownership goal.

### 5.2 Thin host plus one feature Plugin — selected

Convax supplies native and security-sensitive primitives. One sandboxed Pet Plugin
owns the overlay renderer, animation rules, packaged library, and settings UI. This
makes the feature genuinely installable while preserving the existing trust
boundary.

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
  Violet atlas + pet library + activity presentation logic
                  |
                  | convax.plugin/5 contributes.pet
                  | convax.pet-host/1 scoped ports
                  v
Convax Desktop pet platform
  provider lifecycle + isolated BrowserWindow + settings mount
  activity projection + validated navigation
  installed asset protocol + bounded state storage
                  |
                  v
@convax/agent-runtime and Electron
  projects/sessions             displays/windows
```

### 6.1 Ownership

The Pet Plugin owns:

- overlay HTML, CSS, JavaScript, and accessible interaction behavior;
- collapsed and expanded layouts;
- activity priority and state-to-animation mapping;
- sprite animation timing and reduced-motion presentation;
- pet collection, selection, descriptions, previews, and packaged library data;
- Violet as the initial bundled library entry;
- Plugin preferences that do not require native interpretation.

Convax owns:

- discovering and activating exactly one Pet contribution;
- the transparent, always-on-top, frameless BrowserWindow;
- isolated sessions, CSP, navigation blocking, crash recovery, and fixed preload;
- cross-project content-free Agent activity projection;
- resolving opaque activity IDs and opening the correct project/session;
- validated serving of immutable installed Plugin assets;
- bounded, atomic Plugin-private state storage;
- window position, display identity, scale context, wake/tuck lifecycle, and app
  shutdown ordering.

Convax does not own Violet, animation rows, activity priority, pet cards, packaged
library metadata, or pet-specific copy.

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
    "pet.preferences.write"
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

`library`, `overlay`, and `settings` are package-relative, case-sensitive paths
that must resolve to regular files. Unknown fields and capabilities are rejected.
A Pet feature package remains static Web content; it may contain bundled JavaScript
but no native runtime.

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
| Overlay | activity snapshot/events, activity open, preferences, overlay move/expand |
| Settings | preferences, wake/tuck |

Neither surface can forward arbitrary method names. Requests and responses are
versioned, uniquely identified, size-bounded, schema-validated, and rejected after
the surface or Plugin generation changes.

### 7.3 Host method semantics

The protocol exposes narrow operations equivalent to:

```text
activity.getSnapshot / activity.changed
activity.open
overlay.move / overlay.setExpanded
preferences.get / preferences.update
lifecycle.setAwake
```

Method names are part of the versioned contract; the implementation plan may group
request and event types differently without expanding their authority.

`activity.open` accepts only an opaque activity ID and the snapshot revision.
`preferences.update` accepts an exact bounded schema, not arbitrary filesystem or
application settings. Pet images load from validated package-relative URLs in the
installed Plugin origin.

## 8. Packaged Pet Library

### 8.1 Data model

The Plugin owns a static `convax.pet-library/1` document:

```json
{
  "schema": "convax.pet-library/1",
  "pets": [
    {
      "id": "violet",
      "displayName": "Violet",
      "description": "A pixel companion for Convax.",
      "spritesheet": "assets/violet.webp",
      "spriteVersion": 2,
      "alt": "Violet, the Convax pixel companion"
    }
  ]
}
```

The document and every referenced asset are immutable package files validated at
repository validation and Plugin installation. IDs are unique and stable across
Plugin updates. The Plugin stores only the selected ID and presentation preferences
through the host preference API.

Future pets are added by updating this same Plugin package, incrementing SemVer and
the Registry sequence. Removal of a previously shipped pet must migrate a stale
selection to Violet without waking a tucked overlay.

### 8.2 Package validation

Repository and host validation independently enforce:

- exact library schema and no unknown keys;
- unique safe IDs and bounded display strings;
- normalized package-relative PNG/WebP paths;
- no URL, absolute path, traversal, symlink, reserved name, or case ambiguity;
- real PNG/WebP bytes matching the extension;
- exact 1536 by 1872 dimensions;
- alpha channel and useful transparency;
- maximum 20 MiB asset size;
- every asset remains within the installed package.

The settings surface cannot add, replace, or delete library records at runtime.

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

The Plugin persists its selected packaged pet and presentation preferences through
its bounded private store. No record contains native paths or Agent content.

Disabling or uninstalling the provider closes the overlay, stops global activity
projection, revokes ports, and removes the Pet settings surface. Reinstall starts
from validated Plugin defaults unless compatible private preferences remain.

Updates stage new package bytes before revoking the old generation. State is
reconnected only after the new manifest, library, assets, and entry points validate.
A failed update preserves the previous installed Plugin and selection.

## 11. Security Model

The overlay BrowserWindow uses:

```text
contextIsolation: true
sandbox: true
nodeIntegration: false
frame: false
transparent: true
```

It uses a nonpersistent, Plugin-scoped Electron session. The installed asset
protocol is registered and removed on that same session. Convax blocks navigation,
popups, downloads, permission requests, remote resources, service workers, and
untrusted senders. CSP permits only the installed Plugin bundle and its validated
package assets.

The fixed preload transfers only the surface-specific `convax.pet-host/1` port. It
does not expose Electron APIs, native paths, a generic IPC method, or unrestricted
fetch. Every asynchronous result is bound to the provider and document generation
that requested it.

Installation and packing remain inert. Repository validation may inspect asset
bytes but never executes contributor package scripts during validation or packing.

## 12. Failure Handling

- Runtime temporarily unavailable: publish a generic unavailable activity and
  retry with bounded backoff without leaking diagnostics.
- Stale activity or navigation revision: reject the action and let the Plugin
  refresh its snapshot.
- Overlay renderer crash: recreate once; a second crash tucks the pet and leaves
  Convax usable.
- Settings renderer crash: discard its port and remount through the normal Plugin
  surface lifecycle.
- Missing or invalid packaged pet: reject installation or update before activation.
- Removed selected pet after a valid update: select Violet without waking the pet.
- Corrupt Plugin preferences: restore Violet and safe defaults.
- Display removal, resume, or scale change: clamp the overlay to a visible work
  area, preferring the last display identity.
- App shutdown: reject new requests, revoke ports, persist atomically, stop
  activity work, and close without blocking shutdown.

## 13. Testing Strategy

### 13.1 `convax-plugins`

Schema, validator, packer, and Registry tests cover:

- a valid Pet feature Plugin with both static entry points and a packaged library;
- capability and protocol mismatch, missing entry, unknown field, unsafe path,
  symlink, remote resource, invalid atlas, executable, companion, and install hook
  rejection;
- duplicate library IDs and missing assets;
- retention of unrelated `convax.plugin/5` contributions;
- deterministic ZIP layout and Registry metadata;
- package SemVer and Registry sequence requirements.

Pet Plugin workspace tests cover:

- packaged library parsing and stale-selection fallback;
- activity priority and animation mappings;
- library selection and preference recovery;
- overlay interactions, reduced motion, scrolling, keyboard behavior, and labels;
- settings selection, wake/tuck, and disconnected host requests.

### 13.2 Convax host

Host tests cover:

- singleton provider activation without package-ID special cases;
- per-surface protocol allowlists, identity validation, generation revocation, and
  bounded messages;
- isolated session protocol registration and navigation hardening;
- content-free, fair, bounded cross-project activity projection;
- opaque navigation resolution and stale revision rejection;
- validation and serving of library files and sprite assets;
- bounded preferences and native lifecycle persistence;
- wake/tuck, multi-display restore, crash recovery, update, uninstall, and shutdown.

### 13.3 End-to-end acceptance

1. Install and enable Convax Pet; the Plugin-owned settings surface appears but the
   overlay remains tucked.
2. Select and wake bundled Violet; verify idle rendering.
3. Start work in project A and request input in project B; the Plugin applies the
   documented priority.
4. Click the active row; Convax focuses and opens the correct project/session.
5. Enable reduced motion and verify no animation timer runs.
6. Restart and restore the selected packaged pet, wake state, and visible display
   position.
7. Disable or uninstall the Plugin; the overlay and activity subscription stop.
8. Reinstall and recover valid preferences or safe Violet defaults.
9. Perform the complete flow offline with no remote request.

## 14. Migration from the Prototype

Because the current Pet contract has not been published, migration replaces it
before release rather than supporting two public models.

### `convax-plugins`

- Replace the one-pet manifest fields with feature `overlay`, `settings`,
  `protocol`, and packaged-library entries.
- Move Violet metadata into `convax.pet-library/1` and add bundled static Web
  surfaces.
- Move animation, priority, collection, and settings tests into the Plugin
  workspace.
- Update schema, authoring, packaging, Registry documentation, tests, version, and
  Registry sequence.

### `/Users/bytedance/src/convax`

- Keep and generalize the secure window, activity projection, navigation,
  persistence, asset inspection, and lifecycle foundations.
- Replace host-owned pet React UI and product controller logic with provider
  activation, surface mounting, scoped protocol ports, and bounded preferences.
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

- installing one Convax Pet Plugin provides the Plugin-owned overlay, settings,
  Violet, and packaged pet library;
- adding a future pet requires only a new library entry and bundled atlas in the
  same Plugin release, not another Convax Plugin;
- disabling or uninstalling the feature Plugin removes its running feature;
- Convax contains only generic native/security primitives and no Violet, pet card,
  animation mapping, raw pet import, or package-ID special case;
- Plugin code cannot access Agent content, native paths, unrestricted files,
  Node/Electron, network, or arbitrary IPC;
- all repository, host, integration, accessibility, lifecycle, and security tests
  pass.
