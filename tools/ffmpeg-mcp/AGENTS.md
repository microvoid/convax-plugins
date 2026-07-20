# FFmpeg companion contract

This directory owns the separately installed `convax-ffmpeg-mcp` executable for
the `ffmpeg-tools` Tool Plugin. It never enters the Plugin ZIP and must not be
imported by Convax packages.

- Speak only the documented newline-delimited MCP stdio subset on stdout.
- Never send native paths, FFmpeg stderr, environment values, or command lines to
  the host or model. Bounded human diagnostics on stderr identify only the phase.
- Spawn FFmpeg directly with an argv array and `shell: false`. Never evaluate a
  shell command or expand environment variables.
- Read only exact host-staged `{{input:N}}` references and write the one exact
  `{{output}}` below the host-supplied `output_directory`.
- Verify each input is a stable, non-symbolic regular file with a supported host
  media signature. Reject URLs, pipes, absolute/traversal operands, extra outputs,
  path-opening options and filters, and compiled playlist/segmented/multi-output
  formats. The broad FFmpeg argv surface does not grant ambient filesystem or
  network access.
- Require a new empty host output directory, inject the protected output-size
  limit, monitor it throughout execution, and accept exactly one declared regular
  output smaller than 2 GiB.
- Preserve cancellation by terminating the active FFmpeg child before returning.
- The release build downloads the signed, pinned official FFmpeg source archive,
  verifies its byte size and SHA-256, builds it on the matching native runner with
  reviewed flags and a macOS 13.0 deployment target, then embeds the raw FFmpeg
  Mach-O and its SHA-256 into a native Swift arm64 Mach-O companion. The published
  executable must not link Bun, JavaScriptCore, or WebKit. Never commit vendor
  bytes or hand-author Registry artifact digests.
- A target may be published only after its native build passes license, linkage,
  codec, executable, MCP-to-artifact, and Registry digest checks. Never substitute
  an unknown community binary or cross-build a target that cannot be executed.

Run `bun typecheck`, `bun test`, `bun run build`, and the relevant
`build:release:<platform>-<arch>` script before handoff.
