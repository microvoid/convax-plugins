# Third-party notices

This Plugin's separately distributed companion embeds FFmpeg 8.1.2 built from the
official release source.

- Source: https://ffmpeg.org/releases/ffmpeg-8.1.2.tar.xz
- Source size: `11710924` bytes
- Source SHA-256: `464beb5e7bf0c311e68b45ae2f04e9cc2af88851abb4082231742a74d97b524c`
- Detached signature: https://ffmpeg.org/releases/ffmpeg-8.1.2.tar.xz.asc
- Signature size: `520` bytes
- Signature SHA-256: `0a0963fccd70597838073f3e31b20f4a4d8cc2b5e577472c9a5a1f22624246f8`
- Signing key: https://ffmpeg.org/ffmpeg-devel.asc
- Signing-key size: `1709` bytes
- Signing-key SHA-256: `397b3becedcd5a98769967ff1ff8501ddc89f8368b8f766e4701377d7dbaabe5`
- Signer fingerprint: `FCF986EA15E6E293A5644F10B4322F04D67658D8`

Most FFmpeg files are licensed under GNU LGPL 2.1 or later, with some files under
compatible permissive licenses. This reviewed build does not enable FFmpeg's GPL,
version 3, or nonfree components. This Plugin ZIP includes FFmpeg's `LICENSE.md`
as `FFMPEG-UPSTREAM-LICENSE.md`, its `CREDITS` as `FFMPEG-CREDITS`, the complete
LGPL 2.1 text as `FFMPEG-LICENSE`, and these notices. The Release assets also
include the exact corresponding source archive and signature plus the complete
build scripts from the tagged repository. A deterministic SPDX 2.3 SBOM binds the
released native companion SHA-256 to this FFmpeg source package.

FFmpeg includes three DCT files derived from libjpeg. The Independent JPEG Group
(IJG) is credited for that work. Convax does not add to, delete from, or otherwise
modify those three files; they are compiled unchanged from the official FFmpeg
8.1.2 release source.

The Plugin and Convax companion code are separately authored and licensed under
the MIT License. The inert Plugin package contains no FFmpeg executable.
