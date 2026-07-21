# Contributing

Thanks for improving the Convax capability catalog.

## Add a package

1. Copy the closest directory under `templates/` into the matching `packages/`
   collection. Use one kebab-case id everywhere.
2. Keep dependencies and contributor scripts in that workspace's `package.json`.
   Run one root `bun install`; do not add a package-local lockfile. If a build is
   required, make `build` emit the complete self-contained `package/` tree.
3. Fill in `convax-package.json`. For Plugins, keep id, name, description, and
   version equal to `package/manifest.json`.
4. Implement static, self-contained files below `package/`. Runtime CDN imports and
   remote scripts are rejected because a Plugin must remain reviewable offline.
5. Request the smallest capability set. `host.context.get` needs no capability;
   every other method is documented in `docs/plugin-authoring.md`.
6. For a Plugin-owned Skill, declare the v4 `{name,path}` contribution and
   `ownerPluginId`; never copy the Skill workspace into the Plugin directory.
7. Run `bun run check` and inspect the generated ZIP listing. Changing a Plugin-owned
   Skill changes its owner Plugin ZIP too, so bump and release both package versions.
8. Open a PR describing behavior, capabilities, manual tests, and handled data.

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
