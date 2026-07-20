import os from "node:os"

export type SupportedPlatform = "darwin"
export type SupportedArch = "arm64"

export const macosDeploymentTarget = "13.0" as const

export interface FfmpegTarget {
  arch: SupportedArch
  platform: SupportedPlatform
}

export const ffmpegSource = {
  archiveSha256: "464beb5e7bf0c311e68b45ae2f04e9cc2af88851abb4082231742a74d97b524c",
  archiveSize: 11_710_924,
  archiveUrl: "https://ffmpeg.org/releases/ffmpeg-8.1.2.tar.xz",
  directory: "ffmpeg-8.1.2",
  signerKeySha256: "397b3becedcd5a98769967ff1ff8501ddc89f8368b8f766e4701377d7dbaabe5",
  signerKeySize: 1_709,
  signerKeyUrl: "https://ffmpeg.org/ffmpeg-devel.asc",
  signatureUrl: "https://ffmpeg.org/releases/ffmpeg-8.1.2.tar.xz.asc",
  signatureSha256: "0a0963fccd70597838073f3e31b20f4a4d8cc2b5e577472c9a5a1f22624246f8",
  signatureSize: 520,
  signerFingerprint: "FCF986EA15E6E293A5644F10B4322F04D67658D8",
  version: "8.1.2",
} as const

export const targets: readonly FfmpegTarget[] = [{
  arch: "arm64",
  platform: "darwin",
}]

export function targetFor(platform: string, arch: string) {
  const target = targets.find((candidate) => candidate.platform === platform && candidate.arch === arch)
  if (!target) throw new Error(`Unsupported FFmpeg target: ${platform}-${arch}`)
  return target
}

export function hostTarget() {
  return targetFor(os.platform(), os.arch())
}
