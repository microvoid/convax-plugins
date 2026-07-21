# Local AI hard-subtitle erasure engine

This directory owns Subtitle Studio's P0 burned-in subtitle erasure engine. It
belongs to the separately distributed `convax-subtitle-studio-mcp` companion;
it is never part of the static Plugin ZIP and Convax Desktop does not contain
branches, installers, models, or process code for this engine.

The checked-in C++ source is not by itself a distributable runtime. A release
target is valid only after the companion build has produced one self-contained,
codesigned executable artifact, pinned every native dependency and model, passed
the Registry's 128 MiB companion limit, and completed the required license and
golden-video review. Development builds must not be published as installable
companions.

## P0 pipeline

1. Convert the user's normalized rectangle into a bounded text-search ROI. The
   rectangle itself is never used as an erase mask.
2. Run the pinned PP-OCR detector at a bounded sampling rate and resolution.
3. Track credible text polygons across time, expand only those polygons for glyph
   and backing-plate coverage, and reset tracking at scene cuts.
4. Use the pinned LaMa model on anchor frames. Propagate anchors between samples
   with bounded bidirectional optical flow and reject inconsistent candidates.
5. Feather changes strictly inside the accepted mask; pixels outside it remain
   byte-for-byte sourced from the decoded frame.
6. Produce a private lossless intermediate and remux an Electron-playable H.264
   MP4 while preserving supported audio, metadata, chapters, and text-subtitle
   streams.

There is no classical inpainting or remote fallback. Missing models, absent
credible masks, unsupported media, inference failure, encoder failure, and
cancellation all fail explicitly.

The reviewed upstream model families are:

- PaddlePaddle PP-OCRv6 tiny detector ONNX
- OpenCV Foundation LaMa ONNX

Release metadata must pin immutable source revisions, exact sizes and SHA-256
digests. Mutable model URLs are not a runtime contract.

## Native process protocol

The native engine handles one request. The MCP companion launches it without a
shell in a private operation directory, passes host-staged input and
companion-owned model paths, and consumes bounded NDJSON progress/result events.
Neither paths nor command lines cross back to Plugin Web code.

Input shape:

```json
{
  "protocolVersion": 1,
  "operation": "erase-hard-subtitles",
  "input": { "path": "/host-staged/source.mp4", "width": 1920, "height": 1080, "durationMs": 6000 },
  "models": { "detectorPath": "/companion/models/detector.onnx", "inpaintingPath": "/companion/models/lama.onnx" },
  "region": { "x": 154, "y": 778, "width": 1612, "height": 238 },
  "output": { "path": "subtitle-erased.mp4" }
}
```

Output events are `progress`, `result`, or `error`. The engine reports monotonic
global progress across detect, erase, remux, and validate stages. Cancellation is
process-owned: the companion sends `SIGTERM`, waits a bounded grace period, then
uses a hard kill and removes the private work directory.

## Developer build

The engine currently requires CMake 3.25+, a C++20 compiler, OpenCV 5 with
`core`, `dnn`, `geometry`, `imgproc`, `video`, and `videoio`, plus the exact
reviewed model files and FFmpeg/FFprobe runtime. P0 intentionally fails closed on
Windows.

```bash
cmake -S native/subtitle-erasure -B /tmp/convax-subtitle-erasure-build \
  -DOpenCV_DIR=/path/to/opencv-5/lib/cmake/opencv5 \
  -DCMAKE_BUILD_TYPE=Release
cmake --build /tmp/convax-subtitle-erasure-build --config Release
ctest --test-dir /tmp/convax-subtitle-erasure-build --output-on-failure
```

Before release, add packaged-runtime smoke tests and golden videos covering static
and moving backgrounds, scene cuts, multiline/vertical text, no detection,
cancellation, corrupt tensors, outside-mask pixel identity, audio preservation,
long inputs, and every rejected media gate.
