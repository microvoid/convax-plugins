# Local Codex companion contract

This directory owns the separately installed `convax-codex-mcp` companion for
the `codex-service` Plugin. The executable is not part of the Plugin ZIP.

- Bind only to a user-installed Codex executable and its documented app-server
  protocol. Never read, copy, return, or persist Codex tokens, cookies, config,
  rollout files, or SQLite state directly.
- Keep the Codex child on stdio. The only network listener is the random-key,
  loopback-only OpenAI-compatible gateway returned to Convax Main by
  `llm.gateway.start`.
- Service status may use only `account/read`, `account/rateLimits/read`,
  `model/list`, and `modelProvider/capabilities/read`. Return unavailable fields
  honestly and never expose native paths, raw Codex errors, or full rate-limit
  payloads through MCP.
- `service.authorize` and `service.reauthorize` only re-probe the existing local
  Codex binding. They never log the user in, log the user out, open a browser, or
  mutate Codex configuration.
- Accept only the declared GPT-5.6 and GPT-5.5 model ids at the gateway and verify
  that the bound Codex catalog currently exposes the requested model.
- Translate caller tools through Codex dynamic tools. Never execute them in the
  companion. Interrupt the ephemeral Codex turn after capturing a tool call and
  return that call to the OpenAI-compatible caller.
- GPT Image 2 generation uses Codex's built-in `imageGeneration` capability. Read
  only host-staged reference-image paths and write final artifacts only beneath
  the supplied `output_directory`.
- Bound handshake, metadata, and individual protocol requests. Once an LLM or
  image turn starts, keep it alive until completion, explicit failure, child exit,
  or caller cancellation; do not impose an arbitrary overall deadline.
- Human diagnostics go only to stderr and must not include credentials, account
  email addresses, native paths, prompts, model output, or raw upstream bodies.
- The release build writes only `dist/darwin-arm64/convax-codex-mcp`; it must never
  be copied under the Plugin package directory.

Run `bun run typecheck`, `bun test`, `bun run build`, and
`bun run build:release:darwin-arm64` before handoff.
