# Convax Pet Studio and Custom Pet Import Design

**Date:** 2026-07-23
**Status:** Approved for inline execution
**Plugin owner:** `packages/plugins/convax-pet`
**Host owner:** `packages/desktop` in `/Users/bytedance/src/convax`

## Summary

Replace the sparse Pet settings form with a companion-focused studio and add a
real custom-pet workflow. Users import one current-format PNG or WebP sprite
atlas, preview it beside bundled pets, select it without implicitly waking the
overlay, and remove custom entries.

This explicitly does not support legacy Goku folders or `pet.json`. The input is
only a sprite atlas that satisfies the existing sprite-v2 contract:

- PNG or WebP magic bytes matching the extension;
- exactly 1536×1872 pixels;
- at least one transparent pixel;
- at most 20 MiB.

## Experience

The settings surface has two sections:

1. A “current companion” hero with a large live preview, name, description,
   Awake/Tucked status, and one primary Wake/Tuck action.
2. A responsive collection with a count, a prominent “Add custom pet” action,
   larger pet cards, clear selected state, Bundled/Custom badges, and a remove
   action only on custom cards.

Selecting never wakes a tucked pet. A successful import selects the new pet but
also preserves the current awake/tucked state. Deleting the selected custom pet
falls back to Violet and preserves lifecycle state. Import cancellation is
silent; invalid files produce actionable, bounded copy in the settings surface.

## Architecture and trust boundary

The Plugin remains an inert static Web package. It owns layout, copy, previews,
collection composition, selection, and confirmation UI. It receives only
bounded custom-pet descriptors and opaque asset URLs.

Convax Main owns the file picker, byte/signature/dimension/transparency
validation, managed storage, deletion, and asset serving. Imported bytes are
copied through a private staging directory and atomically renamed into
`userData/pets/<opaque-id>`. Host-authored metadata never records the source
path.

`convax.pet-host/1` gains:

- `collection.get` for overlay and settings;
- `collection.import` and `collection.delete` for settings only;
- `collection.changed` for both surfaces.

All three require a new exact `pet.custom.manage` capability. The Host never
accepts a renderer-supplied path: `collection.import` opens the native picker.
The package CSP admits only the local `convax-pet-asset:` image scheme.

## Persistence and assets

Each custom pet directory contains:

- `metadata.json` using strict `convax.custom-pet/1`;
- `spritesheet.png` or `spritesheet.webp`.

Custom IDs are `custom-<UUID>`, remain within the existing preference ID grammar,
and are exposed only as opaque identifiers. Listing and resolving revalidate
real directories, regular files, metadata, and decoded atlas properties.
Tampered records disappear from inventory rather than leaking filesystem
details.

The asset protocol accepts only one canonical opaque ID and resolves through the
custom-pet store. It is registered in both the main renderer session and the
isolated Pet overlay session.

## Failure and lifecycle behavior

- Cancelled picker: no mutation and no error.
- Invalid atlas: staging is removed; current selection and awake state remain.
- Duplicate/generated collision: import fails closed.
- Selected custom pet deletion: Plugin selects Violet, then removes the custom
  record; if deletion fails the record remains selected.
- Tucked/awake behavior remains explicit.
- Provider replacement, overlay crash recovery, and shutdown continue to own
  their existing lifecycles.

## Verification

Tests cover the custom store’s staging, validation, tamper resistance, bounded
inventory, deletion, and asset resolution; protocol URL rejection; method
surface/capability enforcement; import cancellation; Plugin collection merging;
selection fallback; settings source contract and visual controls; overlay use of
custom descriptors; full repository checks; and a built Electron smoke.

