# Convax Plugins

The official source registry, authoring kit, and release catalog for Convax
Plugins and OpenCode-compatible Skills.

本仓库让作者和 AI 从模板开始，产出可独立验证、确定性打包并由 Convax
安全下载的 Plugin 或 Skill。包源码在 Git 中审查，GitHub Release 承载不可变
ZIP，GitHub Pages 发布轻量 Registry：
`https://microvoid.github.io/convax-plugins/registry/v1/index.json`。

## Quick start

Requirements: [Bun](https://bun.sh/) 1.3.14 or newer.

```sh
cp -R templates/plugin-basic packages/plugins/my-plugin
# Replace every __TOKEN__ and implement package/index.html.
bun run validate
bun test
bun run pack -- --kind plugin --id my-plugin
```

The generated Plugin ZIP has `manifest.json` at its root. A Skill ZIP has
`SKILL.md` at its root. No dependency install or contributor build script is run
while validating or packing a package.

See the working example in
[`packages/plugins/hello-convax`](packages/plugins/hello-convax), then read:

- [`docs/plugin-authoring.md`](docs/plugin-authoring.md) for the sandbox and host protocol;
- [`docs/skill-authoring.md`](docs/skill-authoring.md) for safe, portable Skills;
- [`docs/packaging.md`](docs/packaging.md) for ZIP and release rules;
- [`docs/registry-spec.md`](docs/registry-spec.md) for the client contract;
- [`CONTRIBUTING.md`](CONTRIBUTING.md) before opening a pull request.

## Repository layout

```text
packages/plugins/<id>/
  convax-package.json
  package/                 # ZIP root; manifest.json must be here
packages/skills/<id>/
  convax-package.json
  package/                 # ZIP root; SKILL.md must be here
templates/                 # copy-only author starters
tooling/                   # validation and deterministic ZIP
schemas/                   # package, Registry, and Plugin JSON Schemas
dist/                      # generated; never committed
```

## Commands

```sh
bun run validate            # validate all source packages
bun test                    # validator, ZIP, Registry, and protocol tests
bun run pack                # pack every package into dist/packages
bun run build:index         # create dist/registry/v1/index.json at current Git SHA
bun run check               # complete local CI sequence
```

To publish one package, create an annotated tag that exactly matches its metadata:

```text
plugin-<id>-v<version>
skill-<id>-v<version>
```

For example: `plugin-hello-convax-v0.1.0`. The publish workflow validates the
tag, creates the deterministic ZIP and Registry entry, attests the ZIP, and creates
a GitHub Release. The Pages workflow rebuilds the catalog from published Release
entries only.

## Trust boundary

Third-party Plugins are static HTML/CSS/JavaScript rendered by Convax in an iframe
with exactly `sandbox="allow-scripts"`. They cannot contain native executables,
Node/Electron code, network permissions, or a generic host bridge. Every host call
is scoped to the mounted Plugin node and checked against the manifest capability
allowlist. Skills are instructions, not executable capability grants.

## License

Repository tooling, templates, and `hello-convax` are MIT licensed. Each submitted
package must declare its license and include notices its dependencies require.
