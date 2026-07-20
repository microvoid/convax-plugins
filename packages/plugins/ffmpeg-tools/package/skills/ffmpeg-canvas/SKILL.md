---
name: ffmpeg-canvas
description: Transform image, video, or audio with FFmpeg for operations such as extracting frames, trimming, cropping, separating audio, transcoding, remuxing, filtering, or combining media. Use the direct FFmpeg tools for managed Convax Canvas nodes when available, or an authorized argv-based local process for explicit files in other compatible agents such as Codex.
---

# FFmpeg Canvas

Turn a media request into a reviewable FFmpeg argv vector, execute it through the
safest available route, and preserve every source file or node.

## Select the execution route

1. Inspect the capabilities available in the current session.
2. Prefer the managed Convax route when `ffmpeg_run_image`, `ffmpeg_run_video`,
   or `ffmpeg_run_audio` is available. A client may display these with its server
   prefix, such as `convax_ffmpeg_run_video`. Read
   [references/convax.md](references/convax.md) before calling one.
3. Otherwise, use the local route only when the client exposes a user-authorized
   argv-based process capability and `ffmpeg` plus `ffprobe` are installed.
4. If neither route exists, return the proposed argv, output name, and verification
   checklist as a handoff. Never claim execution occurred.

## Define the transform

Identify the precise operation, input order, output container or image format,
stream mapping, time range, dimensions, codecs, and quality tradeoffs. Ask only
when a missing choice changes the result materially. Preserve metadata and audio
only when requested or when the chosen operation should reasonably retain them.

Build argv as an array of literal tokens. Never build a shell command, interpolate
untrusted text into a command string, or use shell expansion. Produce a new output;
do not replace, delete, or modify an input.

## Use an authorized local process

Use this route only for files the user explicitly supplied or named. Do not scan
directories to discover media.

1. Run `ffmpeg -version` and `ffprobe -version` through the authorized process tool
   with argv execution and no shell. Stop if either command is unavailable.
2. Inspect each explicit input with `ffprobe` before selecting streams or codecs.
3. Choose a new output path approved by the user or a clearly named sibling output.
   Use FFmpeg's no-overwrite mode (`-n`), plus `-nostdin` and `-hide_banner`.
4. Execute the argv directly. Treat a nonzero exit, cancellation, or uncertain
   process state as failure and do not retry a possibly completed operation without
   checking the output first.
5. Validate the new file with `ffprobe`, including expected format, duration,
   dimensions, and streams. Report the exact new path only after validation.

Do not use network inputs, ambient credentials, unrelated files, or a shell. Ask
before a costly batch or a transform that may substantially reduce quality.

## Finish safely

Report the chosen route, essential transform settings, validated output, and any
quality or compatibility warnings. On partial failure, report the last confirmed
state and leave cleanup or retry to an explicit user decision.
