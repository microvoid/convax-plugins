# Convax Pet Runtime Fixes Design

**Status:** Approved

## 1. Goal

Fix four production defects in the Convax Pet feature while preserving the
published ownership boundary:

1. `Ready` must mean completed and unread, and must clear whenever the matching
   conversation is actually displayed—not only when navigation started from the
   pet.
2. Waking the pet while Convax is in a macOS full-screen Space must show the pet
   in that Space without activating a second normal application window.
3. Agent activity that needs attention must produce a native desktop
   notification while Convax is in the background.
4. Dragging must track the pointer smoothly without coordinate feedback or
   out-of-order movement.
5. Expanding or closing the activity tray must keep the pet anchored and avoid
   rendering a large surface inside the old native bounds.

The separately distributed owners remain:

- `packages/plugins/convax-pet` owns activity presentation and drag gesture
  production.
- `/Users/bytedance/src/convax/packages/desktop` owns native windows, native
  notifications, trusted conversation visibility, activity acknowledgement,
  navigation, and persistence.

No private Convax implementation is copied into the Plugin package.

## 2. Evidence and Root Causes

### 2.1 Ready remains visible

The host projects a completed assistant turn as `ready` until a persisted
watermark reaches the activity update timestamp. The only current watermark
write happens after pet-originated navigation successfully opens a session.
Opening or already viewing the same session through the normal Agent panel does
not acknowledge it.

The local runtime state confirms this mismatch: a visible session can have an
update timestamp newer than its persisted Pet watermark. Polling therefore
correctly reconstructs it as unread on every refresh, even though the user has
already seen the conversation.

`Ready` itself is not transient. It remains the documented completed-and-unread
state and is never cleared by a timer or merely by rendering the pet status.

### 2.2 Full-screen wake changes window context

The Pet overlay is currently created as a normal frameless `BrowserWindow`.
`alwaysOnTop` does not make a normal macOS window join full-screen Spaces.
Electron provides the macOS `panel` window type specifically for a
non-activating window that floats above full-screen applications and appears on
all Spaces.

### 2.3 No message notification

The current implementation has no native notification controller. An activity
event only updates the Plugin-owned animation, status pill, and tray. This is not
an event-loss bug.

### 2.4 Drag jumps

The Plugin computes movement from renderer-relative `clientX` and `clientY`.
Moving the native window changes that coordinate system under the pointer, which
feeds an inverted or repeated delta into the next move. Every pointer event also
starts an independent host request, so a busy renderer can create avoidable
movement backlog.

### 2.5 Tray expansion and collapse shake

The Plugin optimistically renders the next 356 by 320 or 176 by 176 layout
before the host changes the native window bounds. This paints a clipped
intermediate frame. The host also resizes around the current top-left corner
while the pet stage is positioned at the bottom-right, so the pet changes screen
position by the complete size delta in both directions.

## 3. Selected Design

### 3.1 Conversation visibility is the read boundary

The trusted main renderer reports a bounded `{ projectId, sessionId }` identity
when:

- the standalone Agent panel is open;
- conversation history is not covering the conversation;
- the requested session state has loaded; and
- the document is visible.

Embedded conversation panels report the same signal when their conversation is
visible. Main resolves the current activity record and persists its current
watermark. Only `ready` and `blocked` become idle; `running` and `needs-input`
retain their state.

The existing activity-id-plus-revision acknowledgement remains valid for
pet-originated navigation. Both paths converge on the same Main-owned watermark
operation. Repeated visibility reports are idempotent.

This avoids three incorrect alternatives:

- rendering the word `Ready` does not mark a conversation read;
- a timeout does not erase unread work;
- the Plugin never receives or authors native project/session state.

### 3.2 Full-screen native window behavior

On macOS the host creates the overlay as `type: "panel"`,
`fullscreenable: false`, and explicitly makes it visible on all workspaces with
`visibleOnFullScreen: true`. The overlay continues to use `showInactive()` and
must not steal focus when woken or when activity changes.

Other platforms retain the existing hardened frameless overlay behavior. The
security properties—sandbox, context isolation, disabled Node integration,
isolated partition, blocked navigation, downloads, permissions, and popups—do
not change.

### 3.3 Native notifications

A Main-owned notification controller subscribes to Pet activity while the Pet
provider is awake. It:

- treats the first snapshot as a baseline and never floods historical activity;
- detects transitions into `ready`, `blocked`, and `needs-input`;
- notifies only while the main Convax window is absent, hidden, minimized, or
  unfocused;
- uses only bounded project/session labels and host-authored status copy;
- emits no prompt, response, tool, path, or error content;
- deduplicates the same activity state and timestamp;
- opens the exact validated activity when the notification is clicked; and
- disposes notifications and subscriptions with the Pet application lifecycle.

The Pet tray remains separate from native notifications. `running` does not
notify. Development builds may be unable to display macOS notifications when
unsigned; unit tests cover the controller and packaged acceptance covers actual
delivery.

### 3.4 Stable drag transport

The Plugin gesture reads `screenX` and `screenY`, which stay stable as the native
window moves. It keeps the four-pixel threshold and emits logical deltas.

A small Plugin-owned movement scheduler allows at most one `overlay.move`
request in flight. Additional move deltas are accumulated and coalesced. The
final `end` request is sent only after earlier movement is accounted for and
persists the final host-clamped position exactly once. Errors remain contained
and do not break future drags.

The host remains authoritative for display selection, bounds clamping, scale
context, and persisted position.

### 3.5 Stable tray resize

The Plugin requests `overlay.setExpanded` while retaining the current committed
DOM. It renders the next layout only after the host confirms the native resize;
a failed request leaves the current view unchanged.

The host treats the current bottom-right corner as the resize anchor. Expanding
grows left and upward, and collapsing shrinks back toward the same point. It
clamps the resulting complete surface to the matching display work area. This
keeps the 176 by 176 pet stage at the same screen position throughout the
transition.

## 4. Contract Changes

The trusted main preload gains one internal IPC operation for visible-session
acknowledgement. This is not exposed to Plugin Web content.

`convax.pet-host/1` does not gain notification or read-authority methods. The
Plugin continues to receive only the already documented content-free activity
snapshot and overlay movement port.

No manifest capability or package schema changes are required.

## 5. Testing

### Plugin

- drag threshold and deltas use screen coordinates even when client coordinates
  shift;
- movement requests are serialized and coalesced;
- the final position is committed once;
- request failures do not poison the scheduler.
- expansion state commits only after host acknowledgement and failed requests
  preserve the previous layout.

### Convax Desktop

- visible standalone and embedded sessions acknowledge matching terminal
  activity;
- hidden/collapsed/history-covered conversations do not acknowledge;
- stale or unknown session identities fail closed or no-op safely;
- the macOS overlay uses a non-activating full-screen-capable panel and still
  calls `showInactive`;
- expanding and collapsing preserve the pet stage's bottom-right screen anchor;
- notification baseline, transition detection, background policy,
  deduplication, click navigation, and disposal are covered;
- existing activity priority, stale-revision, security, crash recovery, and
  multi-display movement tests remain green.

### Acceptance

1. Wake the pet while Convax is full-screen; it appears in the current Space
   without focusing a separate normal window.
2. Complete a turn while its conversation is visible; the pet returns to idle.
3. Complete a turn in another conversation while Convax is backgrounded; one
   system notification appears and the pet shows `Ready`.
4. Click the notification; Convax opens the exact conversation and `Ready`
   clears after it is displayed.
5. Drag quickly in both directions and across displays; the pet follows the
   pointer without oscillation and restores the final saved position.
6. Open and close the activity tray repeatedly; the pet remains in place and no
   clipped intermediate panel is painted.

## 6. Release

Plugin byte changes require `convax-pet` version `0.2.2` and a Registry sequence
increment. Convax host changes ship from its own `codex/convax-pet` branch. The
Plugin release must not claim host-only fixes are available in an older Convax
build.
