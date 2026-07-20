# Managed Convax execution

Use this route only in an active Convax scope that advertises `canvas_generate`
and the required installed `ffmpeg-tools` tool.

1. Query the active Canvas and retain its current `canvasId`, revision, relevant
   node ids, and a free anchor position. Never infer native Project paths.
2. Choose the tool by output artifact: `ffmpeg-tools/run.image`,
   `ffmpeg-tools/run.video`, or `ffmpeg-tools/run.audio`.
3. Give every input node one accepted reference role and preserve reference order.
   `{{input:0}}` addresses the first reference, `{{input:1}}` the second, and so on.
4. Encode FFmpeg argv as a JSON array of strings in
   `toolInput.arguments_json`. Do not include `ffmpeg` or shell quoting. Use the
   exact `{{output}}` token once, as the final argv element.
5. Put a portable basename with an extension matching the output modality in
   `toolInput.output_name`.
6. Call `canvas_generate` with the latest `anchor`, `canvasId`, `commandId`,
   `expectedRevision`, `prompt`, `references`, `toolId`, `output`, and `toolInput`.

Example transform fields for extracting a PNG at 12.5 seconds:

```json
{
  "toolId": "ffmpeg-tools/run.image",
  "output": "image",
  "references": [{"nodeId": "<video-node-id>", "role": "reference_video"}],
  "toolInput": {
    "arguments_json": "[\"-ss\",\"12.5\",\"-i\",\"{{input:0}}\",\"-frames:v\",\"1\",\"{{output}}\"]",
    "output_name": "frame.png"
  }
}
```

The companion accepts a broad FFmpeg argv surface, not an unrestricted process.
Every input path must be an exact placeholder and the only output path must be
`{{output}}`. Inputs must match host-supported media signatures; URLs, ambient
paths, playlist demuxers, multi-file muxers, local devices, path-opening flags,
and external-file filters are rejected. One output smaller than 2 GiB is allowed.
Do not weaken or work around that boundary.

Success requires created node ids and a new Canvas revision. Keep source nodes
unchanged. If the revision is stale, re-query once and rebuild the request against
unchanged sources. On denial, cancellation, missing Plugin, or uncertain outcome,
stop and report the last confirmed state. Never edit `.convax` metadata directly.
