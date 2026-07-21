export type SubtitleJobKind =
  | "create-document"
  | "erase-hard"
  | "erase-soft"
  | "export-srt"
  | "import-srt"
  | "inspect"
  | "preview"
  | "transcribe"
export type SubtitleJobStatus = "canceled" | "failed" | "queued" | "running" | "succeeded"

export interface SubtitleJobState<TResult = unknown> {
  error?: string
  id: string
  kind: SubtitleJobKind
  progress: number
  result?: TResult
  stage: string
  status: SubtitleJobStatus
}

function requireProgress(value: number) {
  if (!Number.isFinite(value) || value < 0 || value > 1)
    throw new Error("Subtitle job progress must be between 0 and 1")
  return value
}

function requireStage(value: string) {
  if (!value.trim() || value.length > 256) throw new Error("Subtitle job stage must be a non-empty string")
  return value
}

function requireMutable(state: SubtitleJobState) {
  if (state.status === "canceled" || state.status === "failed" || state.status === "succeeded") {
    throw new Error(`Subtitle job is already ${state.status}`)
  }
}

export function createSubtitleJob(id: string, kind: SubtitleJobKind): SubtitleJobState {
  if (!id.trim() || id.length > 256) throw new Error("Subtitle job id must be a non-empty string")
  return { id, kind, progress: 0, stage: "queued", status: "queued" }
}

export function startSubtitleJob(state: SubtitleJobState, stage = "starting"): SubtitleJobState {
  requireMutable(state)
  if (state.status !== "queued") throw new Error("Only a queued subtitle job can start")
  return { ...state, stage: requireStage(stage), status: "running" }
}

export function advanceSubtitleJob(state: SubtitleJobState, progress: number, stage: string): SubtitleJobState {
  requireMutable(state)
  if (state.status !== "running") throw new Error("Only a running subtitle job can report progress")
  const nextProgress = requireProgress(progress)
  if (nextProgress < state.progress) throw new Error("Subtitle job progress cannot move backwards")
  return { ...state, progress: nextProgress, stage: requireStage(stage) }
}

export function succeedSubtitleJob<TResult>(
  state: SubtitleJobState,
  result: TResult,
  stage = "complete",
): SubtitleJobState<TResult> {
  requireMutable(state)
  if (state.status !== "running") throw new Error("Only a running subtitle job can succeed")
  return { ...state, progress: 1, result, stage: requireStage(stage), status: "succeeded" }
}

export function failSubtitleJob(state: SubtitleJobState, error: unknown): SubtitleJobState {
  requireMutable(state)
  const message = error instanceof Error ? error.message : String(error)
  if (!message.trim()) throw new Error("Subtitle job failure must have an error message")
  return { ...state, error: message, stage: "failed", status: "failed" }
}

export function cancelSubtitleJob(state: SubtitleJobState, stage = "canceled"): SubtitleJobState {
  requireMutable(state)
  return { ...state, stage: requireStage(stage), status: "canceled" }
}
