import { describe, expect, test } from "bun:test"

import {
  advanceSubtitleJob,
  cancelSubtitleJob,
  createSubtitleJob,
  failSubtitleJob,
  startSubtitleJob,
  succeedSubtitleJob,
} from "../src/domain/jobs"

describe("subtitle job state", () => {
  test("supports monotonic progress and one terminal result", () => {
    const queued = createSubtitleJob("job-1", "transcribe")
    const running = startSubtitleJob(queued, "extracting audio")
    const decoding = advanceSubtitleJob(running, 0.5, "transcribing")
    expect(succeedSubtitleJob(decoding, { trackId: "source" })).toMatchObject({ progress: 1, status: "succeeded" })
    expect(() => advanceSubtitleJob(decoding, 0.4, "backwards")).toThrow("backwards")
  })

  test("fails or cancels without allowing a later success", () => {
    const running = startSubtitleJob(createSubtitleJob("job-1", "erase-hard"))
    const failed = failSubtitleJob(running, new Error("ffmpeg failed"))
    const canceled = cancelSubtitleJob(running)
    expect(failed).toMatchObject({ error: "ffmpeg failed", status: "failed" })
    expect(canceled.status).toBe("canceled")
    expect(() => succeedSubtitleJob(failed, {})).toThrow("already failed")
    expect(() => succeedSubtitleJob(canceled, {})).toThrow("already canceled")
  })
})
