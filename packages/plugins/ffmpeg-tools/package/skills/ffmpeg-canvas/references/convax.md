# Managed Convax execution

Use this route only in an active Convax scope that advertises the required Agent
tool declared by the installed `ffmpeg-tools` Plugin. Host-derived names are
`plugin_ffmpeg_tools_run_image`, `plugin_ffmpeg_tools_run_video`, and
`plugin_ffmpeg_tools_run_audio`; OpenCode normally displays them with its MCP
server namespace as `convax_plugin_ffmpeg_tools_run_image`,
`convax_plugin_ffmpeg_tools_run_video`, and
`convax_plugin_ffmpeg_tools_run_audio`. Use the form actually advertised by the
client. Do not call a Canvas generation tool; that route
is reserved for tools explicitly cataloged as generative models.

1. Use the Canvas query capability when needed to identify current managed input
   node ids. Never infer native Project paths.
2. Choose the declared Agent tool by output artifact: image, video, or audio.
3. Give every input node one accepted reference role and preserve reference order.
   `{{input:0}}` addresses the first reference, `{{input:1}}` the second, and so on.
4. Build FFmpeg argv as an array of literal strings, then JSON-stringify that array
   into scalar `toolInput.arguments_json`. Do not include `ffmpeg`, a shell command,
   or shell quoting. Use the exact `{{output}}` token once as the final argv item.
5. Put a portable basename with an extension matching the selected output tool in
   scalar `toolInput.output_name`. Never pass `arguments` or `outputName` at the
   top level.
6. Call the declared Agent tool with top-level `references`, `toolInput`, optional
   `anchor`, and optional `relationNodeIds` for output-to-output Canvas
   relationships. `toolInput` values are scalars. Convax derives active scope,
   revision, actor, and operation id.

Example `convax_plugin_ffmpeg_tools_run_image` input for a PNG at 12.5 seconds:

```json
{
  "references": [{ "nodeId": "<video-node-id>", "role": "reference_video" }],
  "toolInput": {
    "arguments_json": "[\"-ss\",\"12.5\",\"-i\",\"{{input:0}}\",\"-frames:v\",\"1\",\"{{output}}\"]",
    "output_name": "frame.png"
  }
}
```

For an exact 3-to-5-second MP4 trim on the official Apple Silicon companion, use
the guaranteed VideoToolbox H.264 encoder and software fallback:

```json
{
  "references": [{ "nodeId": "<video-node-id>", "role": "reference_video" }],
  "toolInput": {
    "arguments_json": "[\"-ss\",\"3\",\"-i\",\"{{input:0}}\",\"-t\",\"2\",\"-map\",\"0:v:0\",\"-map\",\"0:a?\",\"-c:v\",\"h264_videotoolbox\",\"-allow_sw\",\"1\",\"-b:v\",\"8M\",\"-profile:v\",\"high\",\"-pix_fmt\",\"yuv420p\",\"-c:a\",\"aac\",\"-b:a\",\"192k\",\"-movflags\",\"+faststart\",\"{{output}}\"]",
    "output_name": "trim-3s-5s.mp4"
  }
}
```

## Separate audio and video

Always produce two new Canvas nodes: one video without audio and one independent
audio file without video. Do not treat audio extraction alone as completion. Call
the video and audio Agent tools against the same source node.

First call `convax_plugin_ffmpeg_tools_run_video`:

```json
{
  "references": [{ "nodeId": "<video-node-id>", "role": "reference_video" }],
  "toolInput": {
    "arguments_json": "[\"-i\",\"{{input:0}}\",\"-map\",\"0:v:0\",\"-an\",\"-c:v\",\"h264_videotoolbox\",\"-allow_sw\",\"1\",\"-b:v\",\"8M\",\"-profile:v\",\"high\",\"-pix_fmt\",\"yuv420p\",\"-movflags\",\"+faststart\",\"{{output}}\"]",
    "output_name": "video-only.mp4"
  }
}
```

Record the returned video node id. Then call `convax_plugin_ffmpeg_tools_run_audio` and
relate the new audio card to the video-only card:

```json
{
  "references": [{ "nodeId": "<video-node-id>", "role": "reference_video" }],
  "relationNodeIds": ["<created-video-only-node-id>"],
  "toolInput": {
    "arguments_json": "[\"-i\",\"{{input:0}}\",\"-map\",\"0:a:0\",\"-vn\",\"-c:a\",\"aac\",\"-b:a\",\"192k\",\"{{output}}\"]",
    "output_name": "audio-only.m4a"
  }
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

Success requires created node ids and a new Canvas revision. Convax creates normal
source-to-output relations for every reference. Keep source nodes unchanged. On
stale input, denial, cancellation, missing Plugin, or uncertain outcome, re-check
the Canvas and report the last confirmed state; do not blindly retry or edit
`.convax` metadata directly.
