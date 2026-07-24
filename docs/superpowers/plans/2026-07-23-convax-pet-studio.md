# Convax Pet Studio Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Redesign Pet settings as a companion studio and support safe current-format custom pet atlas import, selection, preview, and deletion.

**Architecture:** The static Plugin composes bundled and Host-managed pets and owns presentation. Convax Main owns the native picker, strict managed custom-pet store, a read-only asset protocol, and capability-scoped `convax.pet-host/1` collection methods/events.

**Tech Stack:** Bun, JavaScript static Plugin surfaces, TypeScript, Electron 42 protocol/dialog/nativeImage, MessagePort, CSS.

---

## File map

### Convax Desktop

- Create `packages/desktop/src/main/custom-pet-store.ts` and tests: validate,
  atomically persist, list, delete, and resolve custom atlases.
- Create `packages/desktop/src/main/pet-asset-protocol.ts` and tests: serve only
  canonical opaque custom IDs.
- Modify `pet-contracts.ts`, `plugin-contracts.ts`, schemas/tests: add bounded
  collection contracts and exact `pet.custom.manage`.
- Modify `pet-host-connection.ts` and tests: surface/capability validation,
  collection requests, and change events.
- Modify `pet-ipc.ts` and tests: compose native picker and custom store without
  accepting a Plugin path.
- Modify `pet-session.ts`, `index.ts`, and tests: register asset handlers in both
  sessions and dispose them.

### Convax Pet Plugin

- Modify `assets/pet-library.js` and tests: merge strict custom descriptors and
  resolve selected bundled/custom pets.
- Modify `pet/app.js`, `settings/app.js`, and their tests: subscribe to collection
  changes and invoke scoped import/delete methods.
- Replace `settings/styles.css`: current-companion hero, responsive cards,
  selected/custom badges, clear Add action, dark mode, and reduced-motion-safe
  states.
- Update both CSP documents, manifest capability, Registry tests/schemas, and
  package version metadata already staged for 0.2.2.

## Task 1: Custom pet store and read-only asset protocol

- [ ] Add failing tests for valid atomic import, invalid size/transparency,
  cancellation-independent storage, symlink/tamper rejection, deletion, and
  canonical asset URLs.
- [ ] Run the focused tests and confirm missing implementations fail.
- [ ] Implement the strict store using `O_NOFOLLOW`, private staging, exact
  metadata, `nativeImage` inspection, UUID IDs, and revisioned snapshots.
- [ ] Implement the canonical `convax-pet-asset://pet/<id>` handler.
- [ ] Run focused tests and commit `feat(desktop): manage custom pet assets`.

## Task 2: Capability-scoped Host collection protocol

- [ ] Add failing contract and connection tests for `pet.custom.manage`,
  `collection.get/import/delete`, settings-only mutation, and
  `collection.changed`.
- [ ] Run focused tests and verify red.
- [ ] Implement exact parsers, method sets, capability checks, subscriptions,
  native-picker composition, and cleanup.
- [ ] Register the asset scheme in default and Pet sessions.
- [ ] Run focused tests/typecheck and commit
  `feat(desktop): expose managed pet collection`.

## Task 3: Plugin collection model and overlay

- [ ] Add failing tests for strict custom descriptor merging, selected custom
  resolution, stale fallback, and overlay collection subscription.
- [ ] Run tests and verify red.
- [ ] Implement frozen collection composition and use opaque custom asset URLs
  without path access.
- [ ] Update overlay CSP and render flow.
- [ ] Run focused tests and commit `feat(plugin): render custom companions`.

## Task 4: Pet Studio settings redesign

- [ ] Replace the old “no import controls” test with failing assertions for a
  visible Add action, collection methods, custom-only removal, current companion
  hero, and no file input/legacy `pet.json`.
- [ ] Run settings tests and verify red.
- [ ] Implement import/select/delete flows with cancellation, busy/error states,
  selected fallback, and lifecycle preservation.
- [ ] Implement the studio CSS using the existing Convax neutral/purple visual
  language, responsive grid, dark mode, focus-visible states, and large sprite
  preview.
- [ ] Run Plugin tests and commit `feat(plugin): redesign pet studio`.

## Task 5: Release and acceptance

- [ ] Update cross-repo capability schemas, fixed catalog assertions, package
  metadata, lock metadata, and Registry sequence without introducing 0.2.3.
- [ ] Run Convax focused tests, typecheck, full `bun check`, and built Electron
  smoke.
- [ ] Run `bun install --frozen-lockfile --ignore-scripts` and full
  `bun run check` in `convax-plugins`.
- [ ] Inspect the built Settings page and import a valid PNG/WebP atlas; verify
  selection, overlay rendering, deletion fallback, and no legacy folder import.
- [ ] Commit, push both branches, create/merge reviewed PRs, tag
  `plugin-convax-pet-v0.2.2`, and verify protected publish/Pages workflows.

