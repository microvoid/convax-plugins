# Contributing

Thanks for improving the Convax capability catalog.

## Add a package

1. Copy the closest directory under `templates/` into the matching `packages/`
   collection. Use one kebab-case id everywhere.
2. Fill in `convax-package.json`. For Plugins, keep id, name, description, and
   version equal to `package/manifest.json`.
3. Implement static, self-contained files below `package/`. Runtime CDN imports and
   remote scripts are rejected because a Plugin must remain reviewable offline.
4. Request the smallest capability set. `host.context.get` needs no capability;
   every other method is documented in `docs/plugin-authoring.md`.
5. Run `bun run check` and inspect the generated ZIP listing.
6. Open a PR describing behavior, capabilities, manual tests, and handled data.

## Review checklist

- Metadata is accurate, consistent, and uses valid SemVer.
- Static assets are locally included and license-compatible.
- There is no secret, tracker, remote executable, native binary, or hidden network
  dependency.
- Host messages verify parent source, protocol, Plugin id, and transferred port.
- Disconnected and failure states remain usable.

Maintainers publish with the exact tag described in `README.md`. A released version
is immutable. Corrections require a new version; compromised versions are marked
`yanked` rather than replaced.
