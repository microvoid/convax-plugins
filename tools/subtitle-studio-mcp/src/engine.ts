import type { GenerationArtifact, SubtitleGenerationCall } from "./contracts"

export type SubtitleEngineResult =
  | { output: "text"; text: string }
  | { artifacts: GenerationArtifact[]; message?: string; output: "image" | "video" }

/**
 * Runtime boundary for media inspection, transcription, remuxing, and hard
 * subtitle processing. The MCP layer validates host envelopes and result shape;
 * concrete native/model adapters are supplied separately.
 */
export interface SubtitleEngine {
  execute(call: SubtitleGenerationCall, signal: AbortSignal): Promise<SubtitleEngineResult>
}
