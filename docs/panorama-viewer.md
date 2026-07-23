# Panorama Viewer ownership and release

`packages/plugins/panorama-viewer` is the only source tree for the Panorama
Viewer product. Its HTML, CSS, JavaScript, WebGL renderer, manifest, localized
title, toolbar commands, tests, package metadata, and release ZIP all live in
this repository.

Convax Desktop owns only generic host capabilities used by this and other
Plugins:

- bounded reads of directly connected managed Canvas images;
- `canvas.image.create` for one validated PNG;
- managed Project asset admission and rollback;
- revision-checked Canvas image-node creation and connection;
- sandboxed Plugin frames, fullscreen policy, and manifest-driven text toolbar
  buttons.

Desktop must not carry a second Panorama Viewer static bundle or reserve
`panorama-viewer` as a built-in id. Version `0.2.1` targets clean/current profiles
and is installed only as an ordinary Registry package. This release deliberately
does not migrate profiles created by the unreleased trusted built-in implementation;
those experimental profiles must remove the old installation or be reset before
installing this repository's licensed release package.

## Verification

Run the repository's complete release gate:

```sh
bun install --frozen-lockfile --ignore-scripts
bun run check
```

The Panorama package tests additionally assert that the ZIP inventory is static
and offline, the manifest requests only the documented capabilities, and current
viewport capture calls `canvas.image.create`. End-to-end Electron acceptance must
install the packed `0.2.1` artifact through a validated Registry entry and verify
that the installed summary does not contain `trustedBuiltin`.
