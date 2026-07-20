# Managed Convax execution

Use this route only in an active Convax scope that advertises the required direct
FFmpeg tool. Do not route an FFmpeg transform through `canvas_generate`; that tool
is reserved for generative-model Plugins.

1. Use the Canvas query capability when needed to identify the current managed
   input node ids. Never infer native Project paths.
2. Choose the direct tool by output artifact: `ffmpeg_run_image`,
   `ffmpeg_run_video`, or `ffmpeg_run_audio`. A client may display the same names
   with its MCP server prefix, such as `convax_ffmpeg_run_video`.
3. Give every input node one accepted reference role and preserve reference order.
   `{{input:0}}` addresses the first reference, `{{input:1}}` the second, and so on.
4. Pass FFmpeg argv as an array of literal strings in `arguments`. Do not include
   `ffmpeg`, a shell command, or shell quoting. Use the exact `{{output}}` token
   once, as the final argv element.
5. Put a portable basename with an extension matching the selected output tool in
   `outputName`. Optionally provide an `anchor` for the new Canvas node.
6. Call the direct FFmpeg tool with only `references`, `arguments`, `outputName`,
   optional `anchor`, and optional `relationNodeIds` for output-to-output Canvas
   relationships. Convax derives the active Project, Canvas, revision, actor, and
   unique operation identity at execution time.

Example `ffmpeg_run_image` input for extracting a PNG at 12.5 seconds:

```json
{
  "references": [{ "nodeId": "<video-node-id>", "role": "reference_video" }],
  "arguments": [
    "-ss",
    "12.5",
    "-i",
    "{{input:0}}",
    "-frames:v",
    "1",
    "{{output}}"
  ],
  "outputName": "frame.png"
}
```

For an exact 3-to-5-second MP4 trim on the current official Apple Silicon
companion, use the guaranteed VideoToolbox H.264 encoder with its software
fallback instead of assuming the external `libx264` encoder is installed:

```json
{
  "references": [{ "nodeId": "<video-node-id>", "role": "reference_video" }],
  "arguments": [
    "-ss",
    "3",
    "-i",
    "{{input:0}}",
    "-t",
    "2",
    "-map",
    "0:v:0",
    "-map",
    "0:a?",
    "-c:v",
    "h264_videotoolbox",
    "-allow_sw",
    "1",
    "-b:v",
    "8M",
    "-profile:v",
    "high",
    "-pix_fmt",
    "yuv420p",
    "-c:a",
    "aac",
    "-b:a",
    "192k",
    "-movflags",
    "+faststart",
    "{{output}}"
  ],
  "outputName": "trim-3s-5s.mp4"
}
```

## Separate audio and video

Always produce two new Canvas nodes for an audio/video separation request: one
video with no audio stream and one independent audio file with no video stream.
Do not treat audio extraction alone as a completed separation. Each direct tool
admits one output, so call both tools against the same source node. Do not use
`canvas_generate` or put two `{{output}}` tokens in one call.

First call `ffmpeg_run_video` with `-an` to create the video-only node:

```json
{
  "references": [{ "nodeId": "<video-node-id>", "role": "reference_video" }],
  "arguments": [
    "-i",
    "{{input:0}}",
    "-map",
    "0:v:0",
    "-an",
    "-c:v",
    "h264_videotoolbox",
    "-allow_sw",
    "1",
    "-b:v",
    "8M",
    "-profile:v",
    "high",
    "-pix_fmt",
    "yuv420p",
    "-movflags",
    "+faststart",
    "{{output}}"
  ],
  "outputName": "video-only.mp4"
}
```

Record the returned video node id. Then call `ffmpeg_run_audio` with `-vn`
to create the independent audio node, and pass the video node through
`relationNodeIds` so the paired outputs are connected without staging the new
video as another FFmpeg input:

```json
{
  "references": [{ "nodeId": "<video-node-id>", "role": "reference_video" }],
  "relationNodeIds": ["<created-video-only-node-id>"],
  "arguments": [
    "-i",
    "{{input:0}}",
    "-map",
    "0:a:0",
    "-vn",
    "-c:a",
    "aac",
    "-b:a",
    "192k",
    "{{output}}"
  ],
  "outputName": "audio-only.m4a"
}
```

Require both created node ids before reporting complete separation. If one call
succeeds and the other fails or is canceled, preserve the successful node, report
the partial result, and ask before retrying the missing half.

The companion accepts a broad FFmpeg argv surface, not an unrestricted process.
Every input path must be an exact placeholder and the only output path must be
`{{output}}`. Inputs must match host-supported media signatures; URLs, ambient
paths, playlist demuxers, multi-file muxers, local devices, path-opening flags,
and external-file filters are rejected. One output smaller than 2 GiB is allowed.
Do not weaken or work around that boundary.

Success requires created node ids and a new Canvas revision. Convax creates normal
source-to-output relations for every reference, so an extracted audio card remains
connected to its source video. Keep source nodes unchanged. On stale input,
denial, cancellation, missing Plugin, or uncertain outcome, re-check the Canvas and
report the last confirmed state; do not blindly retry. Never edit `.convax`
metadata directly.
