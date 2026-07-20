import type { GenerationOutput } from "./contracts.ts"

export interface XiaoYunqueGenerationTool {
  description: string
  model: XiaoYunqueModel
  name: string
  output: GenerationOutput
}

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
  ["seedream_5.0_pro", "image.seedream_5.0_pro", "Seedream 5.0 Pro"],
  ["seedream_5.0", "image.seedream_5.0", "Seedream 5.0"],
  ["seedream_4.3", "image.seedream_4.3", "Seedream 4.3"],
  // The live web_model_config v5 catalog can include entries that the raw
  // image_generation submit contract does not accept. On 2026-07-20 an
  // accepted Nova 2 run terminated through get_thread with the exact reason
  // `unsupported image_model_name: nova2`; keep it out of the executable tool
  // catalog until that raw submit surface publishes a verified identifier.
  ["seedream_4.5", "image.seedream_4.5", "Seedream 4.5"],
  ["seedream_4.1", "image.seedream_4.1", "Seedream 4.1"],
  ["seedream_4", "image.seedream_4", "Seedream 4"],
  ["nano_banana_pro_1", "image.nano_banana_pro_1", "Nano Banana Pro 1"],
  ["gpt_image_2", "image.gpt_image_2", "GPT Image 2"],
] as const satisfies readonly (readonly [XiaoYunqueImageModel, string, string])[]

const videoTools = [
  ["Seedance_2.0_mini_lite", "video.seedance_2.0_mini_lite", "Seedance 2.0 Mini Lite"],
  ["Seedance_2.0_mini", "video.seedance_2.0_mini", "Seedance 2.0 Mini"],
  ["seedance2.0_fast_vision", "video.seedance2.0_fast_vision", "Seedance 2.0 Fast Vision"],
  ["seedance2.0_vision", "video.seedance2.0_vision", "Seedance 2.0 Vision"],
  ["seedance2.0_fast_direct", "video.seedance2.0_fast_direct", "Seedance 2.0 Fast"],
  ["seedance2.0_direct", "video.seedance2.0_direct", "Seedance 2.0"],
  ["seedance1.5_direct", "video.seedance1.5_direct", "Seedance 1.5"],
  ["Seedance_1.0_fast", "video.seedance_1.0_fast", "Seedance 1.0 Fast"],
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
