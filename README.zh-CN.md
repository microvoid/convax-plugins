[English](README.md) | [简体中文](README.zh-CN.md)

# Convax 插件与技能仓库

这是 Convax 插件与 OpenCode 兼容技能的官方源码仓库、开发工具和发布目录。

开发者或 AI 可以从模板开始，编写能够独立校验、确定性打包并由 Convax 安全下载的
插件或技能。包源码通过 Git 进行审查，不可变 ZIP 由 GitHub Releases 发布，轻量
Registry 由 GitHub Pages 承载：
`https://microvoid.github.io/convax-plugins/registry/v1/index.json`。

## 快速开始

环境要求：[Bun](https://bun.sh/) 1.3.14 或更高版本。

```sh
cp -R templates/plugin-basic packages/plugins/my-plugin
# 替换所有 __TOKEN__，然后实现 package/index.html。
bun run validate
bun test
bun run pack -- --kind plugin --id my-plugin
```

生成的插件 ZIP 在根目录包含 `manifest.json`，技能 ZIP 在根目录包含
`SKILL.md`。校验和打包期间不会安装依赖，也不会执行投稿者提供的构建脚本。

可以先阅读完整示例
[`packages/plugins/hello-convax`](packages/plugins/hello-convax)，然后参考：

- [`docs/plugin-authoring.md`](docs/plugin-authoring.md)：沙箱和宿主协议；
- [`docs/skill-authoring.md`](docs/skill-authoring.md)：安全、可移植的技能规范；
- [`docs/packaging.md`](docs/packaging.md)：ZIP 和发布规则；
- [`docs/registry-spec.md`](docs/registry-spec.md)：客户端 Registry 协议；
- [`CONTRIBUTING.md`](CONTRIBUTING.md)：提交拉取请求前的贡献规范。

## 在 Convax 中安装

在兼容版本的 Convax 中打开“设置 → 技能与插件”。能力目录从上面的公开 Registry
加载。点击安装插件或安装技能后，渲染进程只会把包标识传给主进程，由主进程下载并
校验对应的不可变 Release ZIP。

`microvoid/convax-plugins` 仓库、Registry 和 Release 资源都是公开的，不需要
GitHub 账号或令牌。主应用仓库 `microvoid/convax` 可以继续保持私有，不会影响包安装。

## 仓库结构

```text
packages/plugins/<id>/
  convax-package.json
  package/                 # ZIP 根目录，必须包含 manifest.json
packages/skills/<id>/
  convax-package.json
  package/                 # ZIP 根目录，必须包含 SKILL.md
templates/                 # 可直接复制的开发模板
tooling/                   # 校验与确定性 ZIP 工具
schemas/                   # 包、Registry 和插件的 JSON Schema
dist/                      # 生成目录，不提交到 Git
```

## 常用命令

```sh
bun run validate            # 校验全部源码包
bun test                    # 运行校验器、ZIP、Registry 和协议测试
bun run pack                # 将全部包写入 dist/packages
bun run build:index         # 使用当前 Git SHA 生成 Registry
bun run check               # 执行完整本地 CI
```

发布单个包时，需要创建与元数据完全一致的附注标签：

```text
plugin-<id>-v<version>
skill-<id>-v<version>
```

例如 `plugin-hello-convax-v0.1.0`。发布工作流会校验标签、生成确定性 ZIP 和
Registry 条目、为 ZIP 创建来源证明并发布 GitHub Release。Pages 工作流只根据
已经发布的 Release 条目重建目录。

## 安装问题排查

- `Redirect was cancelled` 表示旧版 Convax 没有正确适配 Electron 对 GitHub
  Release 手动重定向的处理方式。请升级到包含 Electron Release 重定向适配器的版本。
- `Unable to connect` 通常来自代理、DNS、防火墙或离线状态。请在同一台机器上同时检查
  Registry 地址和条目中的 `artifact.url` 是否可访问。
- HTTP `404` 或 `403` 应直接对照 Registry 中的公开地址排查。任何安装请求都不应依赖
  私有的 Convax 主应用仓库。
- 大小、SHA-256、Schema、兼容性或 ZIP 校验失败属于预期的安全拒绝。不要绕过校验，
  应检查已经发布的 Registry 条目和 Release 资源。

## 安全边界

第三方插件只能包含静态 HTML、CSS 和 JavaScript，并由 Convax 放入仅带
`sandbox="allow-scripts"` 的 iframe 中运行。插件不能包含原生可执行文件、
Node/Electron 代码、网络权限或通用宿主桥接。每个宿主调用都绑定当前插件节点，并按
manifest 中声明的最小权限校验。技能只是工作流说明，不会授予可执行权限。

## 许可证

仓库工具、模板和 `hello-convax` 使用 MIT 许可证。每个投稿包都必须声明自己的许可证，
并包含其依赖所要求的声明文件。
