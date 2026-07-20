# FFmpeg Tools for Convax

FFmpeg Tools adds local media transformations to Convax through a reviewed Tool
Plugin companion. Agent workflows can compose FFmpeg argv directly, while Convax
can expose common video-node actions such as Extract Frame, Trim, and Crop in the
node toolbar.

## Tools

The Plugin publishes three generation tool IDs:

- `ffmpeg-tools/run.image`
- `ffmpeg-tools/run.video`
- `ffmpeg-tools/run.audio`

All three tools accept the five Convax media-reference roles (`reference_image`,
`reference_video`, `first_frame`, `last_frame`, and `audio`) so one FFmpeg graph
can combine heterogeneous staged media. Each reference still has to match the
declared role and a supported media signature.

Each tool receives `arguments_json`, a JSON array containing individual FFmpeg
argv tokens. Convax never invokes a shell. Use `{{input:N}}` as a complete token
for each staged Canvas input and use `{{output}}` exactly once as the final token.
For example:

```json
["-ss", "00:00:03", "-i", "{{input:0}}", "-frames:v", "1", "{{output}}"]
```

The tool exposes a broad argv surface, not an unrestricted FFmpeg process.
Options, codecs, filters, maps, expressions, and metadata remain composable within
bounded JSON/token limits. The companion accepts only host-recognized media
signatures, one declared output smaller than 2 GiB, and an empty host output
directory. It rejects ambient filesystem paths, network URLs, pipe outputs,
playlist/manifest demuxers, multi-file muxers, local capture devices, and features
that open undeclared files. Those boundaries keep execution scoped to the Canvas
resources that Convax staged for the operation.

## Companion Skill

The Plugin includes the portable `ffmpeg-canvas` companion Skill. Install it
explicitly from the Plugin detail to let an Agent compose transforms. The same
Skill is also published as a standalone package for Codex and other compatible
Agents; it can use a user-authorized local FFmpeg route when Convax tools are not
available.

## Installation and output

The first release supports Apple Silicon macOS (`darwin-arm64`). Installing or
updating the Plugin is an explicit authorization for the exact manifest and the
Registry-verified companion executable. Convax rechecks that executable before
use and asks for reinstall if its identity changes.

Generated media is returned as a declared artifact. Convax admits it into managed
Project assets and creates a new file node on the current Canvas; the source node
is not overwritten.

The companion contains a pinned, source-built FFmpeg 8.1.2 executable. The Plugin
ZIP includes FFmpeg's upstream license summary and credits, the complete LGPL 2.1
text, and the exact third-party notice. See `THIRD_PARTY_NOTICES.md` and `LICENSE`
for redistribution and license details.
