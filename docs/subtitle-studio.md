# Subtitle Studio architecture

Subtitle Studio is split across the public Plugin Registry and the generic Convax
Plugin host. No Subtitle Studio UI, subtitle domain, model installer, native
process, or hard-coded Plugin identity belongs in the Convax application.

## Ownership

| Layer | Repository owner | Contents |
| --- | --- | --- |
| Static Canvas surface | `packages/plugins/subtitle-studio/package/` | player, operation buttons, local track state, translation orchestration |
| Portable subtitle domain | `tools/subtitle-studio-mcp/src/domain/` | document/SRT/translation/job/erase-plan validation |
| MCP companion | `tools/subtitle-studio-mcp/` | declared tools, staged-media execution, cancellation, runtime verification |
| Hard-erasure engine | `tools/subtitle-studio-mcp/native/subtitle-erasure/` | bounded OCR, temporal tracking, LaMa inpainting, validated remux |
| Generic host ports | `microvoid/convax` | direct connected media, opaque playback/artifacts, text-only Agent prompt, timed-text resources |

The static iframe never receives native paths, executable paths, model paths,
Project paths, shell access, or generic MCP access. Every media source is a direct
incoming Canvas edge and every native operation is one manifest-declared tool.

## Product flow

1. `canvas.connectedMedia.list` discovers the directly connected video and
   `canvas.connectedMedia.playback.open` creates an opaque Range-capable lease. The
   subtitle document is bound to the listed opaque `sourceVersion`, so replacing the
   video cannot apply the previous video's tracks to the new source.
2. Transcription calls `subtitle.transcribe`. The companion selects the video's
   audio stream itself; importing a separate audio file is not required.
3. Subtitle tracks remain editable soft subtitles in the Plugin node state.
   Translation sends only cue ids and text through `agent.prompt` with
   `mode: "text-only"`, which disables all Agent tools.
4. Soft erasure remuxes selected embedded text streams. Tracks created or imported
   in Subtitle Studio are not part of that inspection and are never removed by it.
5. Hard erasure uses a normalized text-search region, detector geometry, temporal
   tracking, and AI inpainting. It produces a detached artifact so the player can
   switch to the exact processed result before publication.
6. “添加到画布” publishes the player video plus validated managed VTT sidecars.
   “导出视频” exports the same current player video, muxing the current soft tracks
   when required. Neither action accepts a caller-selected path.

## Runtime and release gate

The source package currently declares only `darwin-arm64`, matching the repository's
real companion CI coverage. The checked-in native source and protocol tests are not
an installable AI runtime by themselves.

A publishable `0.4.0` companion must still prove all of the following:

- one Registry-admitted executable no larger than 128 MiB;
- no Homebrew, PATH, ambient Python, or machine-local dynamic-library dependency;
- pinned FFmpeg/FFprobe/Whisper/OCR/LaMa inventory with exact sizes and SHA-256;
- complete third-party licenses and model notices;
- signed/notarized macOS artifact and minimum-OS verification;
- real transcription, soft-remux, preview, hard-erasure, mux, cancellation, and
  cleanup smoke tests on packaged bytes;
- golden videos covering motion, scene cuts, no detection, corrupt media, audio
  preservation, and outside-mask pixel identity.

Until that gate passes, the companion entrypoint fails closed instead of falling
back to arbitrary local programs or presenting source-only code as an installed AI
runtime. The publish workflow explicitly rejects `plugin-subtitle-studio-v*` tags;
remove that guard only in the reviewed change that supplies and validates the full
runtime bundle.
