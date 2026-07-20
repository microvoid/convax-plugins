# XiaoYunque generation sidecar contract

This directory owns the separately installed `convax-xiaoyunque-mcp`
executable used by the `xiaoyunque-generation` Tool Plugin. It is not part of
the Plugin ZIP and must never be imported by Convax packages.

- Speak only the documented newline-delimited MCP stdio subset on stdout.
  Human diagnostics go to stderr and must never contain credentials, cookies,
  native reference paths, or response bodies.
- Call XiaoYunque through its HTTP API. Do not shell out to the vendor CLI and
  do not expose provider, model, or credential configuration through Convax.
- The host-owned browser authorization protocol is the only interactive login
  path. `service.authorize` and `service.reauthorize` return exactly
  `convax.plugin-service-browser-authorization/1`; they never open a browser,
  inspect a browser profile, start a loopback callback, exchange a grant, or
  create an Access Key. Only the fixed `service.authorization.complete` tool may
  accept `convax.plugin-service-browser-authorization-completion/1` from the
  host-owned one-shot continuation.
- Accept only the exact official `https://xyq.jianying.com` Cookie origin and the
  source-evidenced `sessionid_pippitcn_web` / `sessionid_ss_pippitcn_web` direct-Web
  allowlist. Legacy persisted `sessionid` / `sessionid_ss` may remain readable for
  upgrade compatibility but must never widen a new browser request or completion. Bind completion to a
  random in-memory authorization id and a bounded timeout; reject stale,
  duplicate, oversized, unknown, or canceled input. Never return Cookie values,
  authorization ids, or raw failures in service status or logs.
- The Cookie session is the sole configured authorization state for generation
  and service metadata. Persist it only in the dedicated atomic Plugin-private
  mode-`0600` store. Reauthorization publishes through one complete atomic
  replacement and must preserve the prior session on cancellation, timeout,
  invalid completion, or pre-commit failure. Sidecar exit discards only pending
  in-memory authorization state; explicit sign-out clears the persisted session.
  Never execute a vendor CLI, scrape a browser, or simulate login.
- `service.status` may call only the fixed first-party account, credit balance,
  and 20-record consumption-history endpoints. Keep their endpoint-specific
  headers/signature exact, bound every response, and never turn missing data into
  guessed metrics. `service.sign_out` clears the local Cookie session and does
  not claim to revoke the remote XiaoYunque account session.
- Only read reference paths and write beneath `output_directory` supplied by
  `convax.generation-call/1`. Never persist those ephemeral paths.
- Image and video behavior must be covered against a local fake API. Live video
  generation is not part of automated verification. Use the first-party Web
  contracts: images submit through `agent/submit_run` and poll `agent/get_thread`;
  video submits the current Canvas direct video-part tool through
  `agent/submit_run` and polls the same `agent/get_thread` entry-list surface.
  Never fall back to the legacy dedicated video-result endpoint. Use an exact model-specific
  parameter shape: both Seedance 2.0 Mini variants omit
  `resolution`, every Canvas video request omits imitation-video input, and Seedance 1.0 Fast
  accepts at most one reference image while omitting video/audio/frame inputs.
  Keep the exposed video model catalog synchronized with the first-party
  `web_model_config` response rather than marketing pages. Generation envelopes
  require an explicit integer `ret: 0` or canonical string `ret: "0"`; task ids
  must match the client-created ids, and only canonical run states 0 through 9
  are accepted.
- Once submission is durably recorded, canonical pending/running states have no
  absolute job deadline. Bound and retry each status request independently; stop
  only for a canonical terminal state, unrecoverable repeated observation failure,
  authentication failure, or caller cancellation, without resubmitting the task.
- Generated binaries and local credentials are ignored build/runtime output.
- The protected release build writes the `darwin/arm64` binary below
  `dist/darwin-arm64/`; repository tooling hashes and publishes it as an independent
  companion asset. It must never be copied below the Plugin's `package/` directory.

Run `bun typecheck`, `bun test`, `bun run build`, and
`bun run build:release:darwin-arm64` before handoff.
