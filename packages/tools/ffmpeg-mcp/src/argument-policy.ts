import path from "node:path"

import type { FileGenerationReference } from "./contracts.ts"
import { FfmpegInputError } from "./contracts.ts"

const inputPlaceholder = /^\{\{input:(0|[1-9][0-9]*)\}\}$/u
const outputPlaceholder = "{{output}}"
const maximumArguments = 256
const maximumArgumentLength = 1_024

const forbiddenOptions = new Set([
  "-attach",
  "-apre",
  "-dump_attachment",
  "-enable_drefs",
  "-filter_complex_script",
  "-filter_script",
  "-fpre",
  "-fs",
  "-pass",
  "-passlogfile",
  "-pre",
  "-progress",
  "-protocol_whitelist",
  "-report",
  "-sdp_file",
  "-stats_enc_post",
  "-stats_enc_pre",
  "-stats_mux_pre",
  "-spre",
  "-use_absolute_path",
  "-vpre",
  "-vstats_file",
])

const filterExpressionOptions = new Set(["-af", "-filter", "-filter_complex", "-lavfi", "-vf"])
const opaqueValueOptions = new Set(["-metadata"])
const pathOpeningFilter = /(?:^|[^A-Za-z0-9_])(?:a?movie|arnndn|ass|fsync|subtitles|a?sendcmd|azmq|zmq|frei0r|ladspa|libplacebo|lut1d|lut3d|lv2|ocr|openclsrc|removelogo|signature|sofalizer|vidstabdetect|vidstabtransform|whisper)\s*=|(?:^|[=,:])(?:dumpfile|file|filename|fontfile|model|model_path|shader|shader_path|textfile)\s*=/iu
const explicitProtocol = /(?:^|[=,;])(?:https?|ftp|async|cache|fd|file|concat|concatf|crypto|data|gopher|hls|icecast|md5|mmsh|mmst|pipe|prompeg|rtmp|rtmps|rtp|sftp|smb|subfile|tcp|tee|tls|udp):/iu
const likelyRelativeFile = /^[^/\\]+\.[A-Za-z][A-Za-z0-9]{0,9}$/u
const safeExpressionAtom = String.raw`(?:[0-9]+(?:\.[0-9]+)?|iw|ih|ow|oh|in_w|in_h|out_w|out_h|sar|dar|hsub|vsub|n|t|pos)`
const safeDivision = new RegExp(String.raw`${safeExpressionAtom}\s*/\s*${safeExpressionAtom}`, "gu")

export interface ResolvedArguments {
  argv: string[]
  outputPath: string
}

function optionBase(token: string) {
  const streamSpecifier = token.indexOf(":")
  return streamSpecifier < 0 ? token : token.slice(0, streamSpecifier)
}

function rejectAmbientOperand(token: string) {
  if (token === "-") {
    throw new FfmpegInputError("FFmpeg pipe operands are not allowed.")
  }
  if (path.isAbsolute(token) || path.win32.isAbsolute(token)) {
    throw new FfmpegInputError("FFmpeg arguments cannot contain absolute paths.")
  }
  if (token.split(/[\\/]/u).includes("..")) {
    throw new FfmpegInputError("FFmpeg arguments cannot contain traversal paths.")
  }
  if (token.includes("\\")) {
    throw new FfmpegInputError("FFmpeg arguments cannot contain native path separators.")
  }
  if (explicitProtocol.test(token) || token.includes("://")) {
    throw new FfmpegInputError("FFmpeg arguments cannot contain network or file URLs.")
  }
  if (pathOpeningFilter.test(token)) {
    throw new FfmpegInputError("This FFmpeg filter can open files outside the staged inputs.")
  }
  if (token.includes("/") && token.replace(safeDivision, "").includes("/")) {
    throw new FfmpegInputError("FFmpeg arguments cannot contain relative path operands.")
  }
  if (likelyRelativeFile.test(token) && !/^[-+]?\d+(?:\.\d+)?$/u.test(token)) {
    throw new FfmpegInputError("FFmpeg file operands must use an exact host placeholder.")
  }
}

function rejectFilterExpression(token: string) {
  if (pathOpeningFilter.test(token)) {
    throw new FfmpegInputError("This FFmpeg filter can open files outside the staged inputs.")
  }
  if (explicitProtocol.test(token) || token.includes("://")) {
    throw new FfmpegInputError("FFmpeg filter expressions cannot contain network or file URLs.")
  }
  if (token.split(/[\\/]/u).includes("..") || token.includes("\\")) {
    throw new FfmpegInputError("FFmpeg filter expressions cannot contain native or traversal paths.")
  }
}

function exactValueOperand(tokens: readonly string[], index: number, option: string) {
  const operand = tokens[index + 1]
  if (typeof operand !== "string") throw new FfmpegInputError(`FFmpeg option ${option} requires a value.`)
  if (operand === outputPlaceholder || inputPlaceholder.test(operand) ||
      operand.includes("{{input:") || operand.includes(outputPlaceholder)) {
    throw new FfmpegInputError("FFmpeg placeholders cannot be used inside metadata or filter expressions.")
  }
  return operand
}

export function resolveFfmpegArguments(
  argumentsJson: string,
  references: readonly FileGenerationReference[],
  outputPath: string,
): ResolvedArguments {
  let parsed: unknown
  try {
    parsed = JSON.parse(argumentsJson) as unknown
  } catch {
    throw new FfmpegInputError("arguments_json must be a JSON array of FFmpeg argv strings.")
  }
  if (!Array.isArray(parsed) || parsed.length === 0 || parsed.length > maximumArguments) {
    throw new FfmpegInputError(`arguments_json must contain 1 to ${maximumArguments} argv strings.`)
  }
  const tokens = parsed.map((value, index) => {
    if (
      typeof value !== "string"
      || value.length === 0
      || value.length > maximumArgumentLength
      || /[\u0000-\u001f\u007f]/u.test(value)
    ) {
      throw new FfmpegInputError(`FFmpeg argument ${index} is invalid.`)
    }
    return value
  })
  if (tokens.at(-1) !== outputPlaceholder) {
    throw new FfmpegInputError("The final FFmpeg argument must be the exact {{output}} placeholder.")
  }
  if (tokens.filter((token) => token === outputPlaceholder).length !== 1) {
    throw new FfmpegInputError("FFmpeg arguments must contain exactly one {{output}} placeholder.")
  }

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]!
    const base = optionBase(token)
    if (forbiddenOptions.has(base)) {
      throw new FfmpegInputError(`FFmpeg option ${base} is not allowed by the scoped execution policy.`)
    }
    if (base === "-i") {
      const operand = tokens[index + 1]
      if (typeof operand !== "string" || !inputPlaceholder.test(operand)) {
        throw new FfmpegInputError("Every FFmpeg -i operand must be an exact {{input:N}} placeholder.")
      }
      index += 1
      continue
    }
    if (opaqueValueOptions.has(base)) {
      exactValueOperand(tokens, index, base)
      index += 1
      continue
    }
    if (filterExpressionOptions.has(base)) {
      rejectFilterExpression(exactValueOperand(tokens, index, base))
      index += 1
      continue
    }
    if (token === outputPlaceholder || inputPlaceholder.test(token)) continue
    if (token.includes("{{input:") || token.includes(outputPlaceholder)) {
      throw new FfmpegInputError("FFmpeg placeholders must occupy a complete argv token.")
    }
    rejectAmbientOperand(token)
  }

  const argv = tokens.map((token) => {
    if (token === outputPlaceholder) return outputPath
    const match = inputPlaceholder.exec(token)
    if (!match) return token
    const referenceIndex = Number(match[1])
    const reference = references[referenceIndex]
    if (!reference) {
      throw new FfmpegInputError(`FFmpeg input placeholder ${referenceIndex} has no matching Canvas reference.`)
    }
    return reference.path
  })
  return { argv, outputPath }
}
