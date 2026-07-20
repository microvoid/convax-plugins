# Third-party notices

This build embeds FFmpeg from the official 8.1.2 source release:

- source: https://ffmpeg.org/releases/ffmpeg-8.1.2.tar.xz
- detached signature: https://ffmpeg.org/releases/ffmpeg-8.1.2.tar.xz.asc
- signature byte size: `520`
- signature SHA-256: `0a0963fccd70597838073f3e31b20f4a4d8cc2b5e577472c9a5a1f22624246f8`
- signing key: https://ffmpeg.org/ffmpeg-devel.asc
- signing-key byte size: `1709`
- signing-key SHA-256: `397b3becedcd5a98769967ff1ff8501ddc89f8368b8f766e4701377d7dbaabe5`
- source byte size: `11710924`
- source SHA-256: `464beb5e7bf0c311e68b45ae2f04e9cc2af88851abb4082231742a74d97b524c`
- release signer fingerprint: `FCF986EA15E6E293A5644F10B4322F04D67658D8`

The reviewed build disables dependency autodetection and network protocols, uses
only FFmpeg, system zlib, and Apple VideoToolbox/AudioToolbox capabilities, and
does not enable GPL, version 3, or nonfree FFmpeg components. Native CI executes
`ffmpeg -L`, requires the PNG, `h264_videotoolbox`, and AAC encoders, rejects GPL,
version 3, and nonfree configurations, and verifies that every dynamic dependency
is an Apple system library. The separately authored companion is licensed under
the MIT License.

No downloaded source or FFmpeg binary is committed to this repository or included
in the inert Convax Plugin ZIP. That separation does not waive redistribution
obligations. Before a production companion Release, the same immutable Release
must mirror the exact corresponding source archive and signature, this repository's
complete build scripts, and all applicable complete license texts and notices. A
target is not supported merely because source can theoretically compile for it.
The complete LGPL-2.1 text is included as `FFMPEG-LICENSE` in this reviewed tool
source; FFmpeg's source archive retains its own per-file license notices.

FFmpeg includes three DCT files derived from libjpeg. The Independent JPEG Group
(IJG) is credited for that work. This build does not add to, delete from, or
otherwise modify those files; it compiles them unchanged from the official FFmpeg
8.1.2 release source. Production Release assets also mirror FFmpeg's upstream
`LICENSE.md` and `CREDITS` files.

Production Releases include a deterministic SPDX 2.3 SBOM that binds the native
companion executable digest to this exact FFmpeg source release.
