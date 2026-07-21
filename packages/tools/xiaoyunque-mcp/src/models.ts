import type { GenerationOutput } from "./contracts.ts"

export interface XiaoYunqueGenerationTool {
  description: string
  model: XiaoYunqueModel
  name: string
  output: GenerationOutput
}

// These unions also cover legacy persisted operations and direct API contract
// tests. Only entries in imageTools/videoTools are exposed through MCP tools/list.
export type XiaoYunqueImageModel =
  | "seedream_5.0_pro"
  | "seedream_5.0"
  | "seedream_4.3"
  | "seedream_4.5"
  | "seedream_4.1"
  | "seedream_4"
  | "nano_banana_pro_1"
  | "gpt_image_2"

export type XiaoYunqueVideoModel =
  | "Seedance_1.0_fast"
  | "seedance1.5_direct"
  | "seedance2.0_direct"
  | "seedance2.0_fast_direct"
  | "seedance2.0_vision"
  | "seedance2.0_fast_vision"
  | "Seedance_2.0_mini"
  | "Seedance_2.0_mini_lite"

export type XiaoYunqueModel = XiaoYunqueImageModel | XiaoYunqueVideoModel

const imageTools = [
  ["seedream_5.0", "image.seedream_5.0", "Seedream 5.0"],
  ["seedream_5.0_pro", "image.seedream_5.0_pro", "Seedream 5.0 Pro"],
] as const satisfies readonly (readonly [XiaoYunqueImageModel, string, string])[]

const videoTools = [
  // The first entry is Convax's default video model. It uses the non-VIP channel.
  ["Seedance_2.0_mini_lite", "video.seedance_2.0_mini_lite", "Seedance 2.0 Mini Lite"],
  ["seedance2.0_direct", "video.seedance2.0_direct", "Seedance 2.0"],
  // VIP channel.
  ["seedance2.0_vision", "video.seedance2.0_vision", "Seedance 2.0 Vision"],
  ["Seedance_2.0_mini", "video.seedance_2.0_mini", "Seedance 2.0 Mini"],
] as const satisfies readonly (readonly [XiaoYunqueVideoModel, string, string])[]

export const generationTools = [
  ...imageTools.map(([model, name, label]) => ({
    description: `Generate an image with XiaoYunque ${label} from a prompt and optional reference images.`,
    model,
    name,
    output: "image" as const,
  })),
  ...videoTools.map(([model, name, label]) => ({
    description: `Generate a video with XiaoYunque ${label} and optional multimodal references.`,
    model,
    name,
    output: "video" as const,
  })),
] as const satisfies readonly XiaoYunqueGenerationTool[]

export function generationToolForName(name: unknown) {
  return typeof name === "string"
    ? generationTools.find((tool) => tool.name === name)
    : undefined
}

export function modelSupportsOutput(model: XiaoYunqueModel, output: GenerationOutput) {
  return generationTools.some((tool) => tool.model === model && tool.output === output)
}
