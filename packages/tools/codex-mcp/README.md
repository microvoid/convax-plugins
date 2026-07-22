# Convax Codex companion

`convax-codex-mcp` binds the Convax Codex Plugin to an existing local Codex
installation. It starts Codex app-server over stdio, reuses Codex-managed login
state without reading credentials, and exposes only the fixed Convax MCP tools.

Supported catalog entries are `gpt-5.6-sol`, `gpt-5.6-terra`,
`gpt-5.6-luna`, `gpt-5.5`, and the built-in GPT Image 2 generation capability.
The actual model and image capability are checked against the bound Codex process
at runtime. Account and quota display degrades to unavailable when Codex does not
provide the corresponding metadata.

The first release target is macOS arm64. The locator checks official application
bundle locations and a real executable named `codex` on the absolute host `PATH`;
it validates `codex --version` before starting app-server. Configure or reconnect
means re-probing that local installation. Login and logout remain owned by Codex.
