import { afterEach, describe, expect, test } from "bun:test"
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import type { GenerationCall } from "../src/contracts.ts"
import {
  GenerationEngine,
  XiaoYunqueGenerationInputError,
  XiaoYunqueObservationRejectedError,
  XiaoYunqueUnsupportedImageModelError,
} from "../src/generator.ts"
import { fingerprintGenerationCall, OperationStore } from "../src/operation-store.ts"
import { webSessionSchema, type StoredWebSession } from "../src/web-session-store.ts"
import {
  XiaoYunqueApi,
  XiaoYunqueReferenceAssetRegistrationError,
  XiaoYunqueRequestRejectedError,
} from "../src/xiaoyunque-api.ts"

const png = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0])
const mp4 = Uint8Array.from([0, 0, 0, 24, 102, 116, 121, 112, 105, 115, 111, 109, 0, 0, 0, 0])
const imageModel = "seedream_5.0" as const
const videoModel = "Seedance_2.0_mini_lite" as const
const visionVideoModel = "seedance2.0_vision" as const
const directories: string[] = []
const testSession: StoredWebSession = {
  authorizedAt: 1,
  cookies: [{
    domain: "",
    name: "sessionid_pippitcn_web",
    path: "/",
    secure: true,
    value: "test-web-cookie",
  }],
  revision: "11111111-1111-4111-8111-111111111111",
  schema: webSessionSchema,
}

async function accountPreflightResponse(input: Request | URL, init?: RequestInit) {
  const request = input instanceof Request ? input : undefined
  const url = input instanceof Request ? new URL(input.url) : input
  if (
    url.pathname !== "/api/biz/v1/common/get_odin_user_info"
    && url.pathname !== "/api/web/v1/workspace/get_user_workspace"
  ) return undefined

  expect(request?.method ?? init?.method).toBe("POST")
  const body = request
    ? await request.json()
    : JSON.parse(String(init?.body))
  if (url.pathname === "/api/biz/v1/common/get_odin_user_info") {
    expect(body).toEqual({})
    return Response.json({ ret: 0, data: { user_id: "consumer-1" } })
  }
  expect(body).toEqual({ uid: "consumer-1" })
  return Response.json({
    ret: 0,
    data: {
      space_id: "space-1",
      workspace_id: "workspace-1",
    },
  })
}

function taskFromSubmitBody(body: Record<string, unknown>) {
  const message = body.message as Record<string, unknown>
  return {
    runId: message.run_id as string,
    threadId: message.thread_id as string,
  }
}

function artifactEntry(
  subType: "biz/x_data_image" | "biz/x_data_video",
  url: string,
) {
  return {
    type: 2,
    artifact: {
      content: [{
        sub_type: subType,
        data: JSON.stringify({
          [subType === "biz/x_data_image" ? "image" : "video"]: { url },
        }),
      }],
    },
  }
}

function directVideoParameters(body: Record<string, unknown>) {
  const message = body.message as Record<string, unknown>
  const [content] = message.content as Array<Record<string, unknown>>
  const directCall = JSON.parse(String(content?.data)) as Record<string, unknown>
  expect(directCall.tool_name).toBe("biz/x_tool_name_video_part")
  return JSON.parse(String(directCall.param)) as Record<string, unknown>
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { force: true, recursive: true })))
})

function call(overrides: Partial<GenerationCall> & Pick<GenerationCall, "operation_id" | "output" | "output_directory">): GenerationCall {
  return {
    schema: "convax.generation-call/1",
    prompt: "Create a quiet paper-cut landscape",
    references: [],
    ...overrides,
  }
}

describe("XiaoYunque generation engine", () => {
  test("maps image/video inputs, downloads verified artifacts, and reuses operation ids", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "xiaoyunque-engine-"))
    directories.push(directory)
    const outputOne = path.join(directory, "output-one")
    const outputTwo = path.join(directory, "output-two")
    const outputVideo = path.join(directory, "output-video")
    await Promise.all([mkdir(outputOne), mkdir(outputTwo), mkdir(outputVideo)])
    const imageBodies: Record<string, unknown>[] = []
    const videoBodies: Record<string, unknown>[] = []
    let uploadCount = 0
    let imageSubmitCount = 0
    let videoSubmitCount = 0
    let videoQueryCount = 0
    let imageTask: ReturnType<typeof taskFromSubmitBody> | undefined
    let videoTask: ReturnType<typeof taskFromSubmitBody> | undefined
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: async (request): Promise<Response> => {
        const url = new URL(request.url)
        if (url.pathname === "/api/web/v1/common/upload_file") {
          uploadCount += 1
          const form = await request.formData()
          expect(form.get("file")).toBeInstanceOf(File)
          expect(form.get("asset_type")).toBe(uploadCount < 3 ? "2" : "4")
          return Response.json({
            ret: 0,
            data: {
              asset_id: `asset-${uploadCount}`,
              download_url: `${url.origin}/uploaded-${uploadCount}`,
              pippit_asset_id: `pippit-${uploadCount}`,
            },
          })
        }
        const accountPreflight = await accountPreflightResponse(request)
        if (accountPreflight) return accountPreflight
        if (url.pathname === "/api/biz/v1/agent/submit_run") {
          const body = await request.json() as Record<string, unknown>
          if (body.agent_name === "pippit_novel_agent_cn_v2") {
            imageSubmitCount += 1
            imageBodies.push(body)
            imageTask = taskFromSubmitBody(body)
            return Response.json({ ret: 0, data: { accepted: true } })
          }
          videoSubmitCount += 1
          videoBodies.push(body)
          videoTask = taskFromSubmitBody(body)
          return Response.json({ ret: 0, data: { accepted: true } })
        }
        if (url.pathname === "/api/biz/v1/agent/get_thread") {
          const body = await request.json() as Record<string, unknown>
          const isVideoTask = body.run_id === videoTask?.runId
          const requestedTask = isVideoTask ? videoTask : imageTask
          expect(body).toEqual({
            run_id: requestedTask?.runId,
            scopes: ["run_list.entry_list"],
            thread_id: requestedTask?.threadId,
          })
          if (isVideoTask) videoQueryCount += 1
          const completed = !isVideoTask || videoQueryCount > 1
          return Response.json({
            ret: 0,
            data: {
              thread: {
                thread_id: requestedTask?.threadId,
                run_list: [{
                  run_id: requestedTask?.runId,
                  thread_id: requestedTask?.threadId,
                  state: completed ? 3 : 2,
                  entry_list: completed
                    ? [artifactEntry(
                        isVideoTask ? "biz/x_data_video" : "biz/x_data_image",
                        `${url.origin}/${isVideoTask ? "result.mp4" : "result.png"}`,
                      )]
                    : [],
                }],
              },
            },
          })
        }
        if (url.pathname === "/result.png") return new Response(png, { headers: { "Content-Type": "image/png" } })
        if (url.pathname === "/result.mp4") return new Response(mp4, { headers: { "Content-Type": "video/mp4" } })
        return new Response("not found", { status: 404 })
      },
    })
    const baseUrl = `http://127.0.0.1:${server.port}`
    const authorizer = {
      session: async () => testSession,
    }
    const operationStore = new OperationStore(path.join(directory, "state", "operations.json"))
    const engine = new GenerationEngine({
      api: new XiaoYunqueApi(baseUrl),
      authorizer,
      operationStore,
      pollIntervalMs: 1,
    })
    try {
      const imageCall = call({ operation_id: "image-operation", output: "image", output_directory: outputOne })
      const first = await engine.generate(imageCall, imageModel, new AbortController().signal)
      const replay = await engine.generate(
        { ...imageCall, output_directory: outputTwo },
        imageModel,
        new AbortController().signal,
      )
      expect(imageSubmitCount).toBe(1)
      expect(first[0]?.mimeType).toBe("image/png")
      expect(replay[0]?.mimeType).toBe("image/png")
      const firstArtifactPath = path.join(outputOne, first[0]!.path)
      expect(new Uint8Array(await readFile(firstArtifactPath))).toEqual(png)
      expect((await lstat(firstArtifactPath)).mode & 0o777).toBe(0o600)
      expect((await readdir(outputOne)).some((name) => name.endsWith(".download"))).toBeFalse()
      expect(imageBodies[0]).toMatchObject({
        agent_name: "pippit_novel_agent_cn_v2",
        user_info: {
          app_id: "795647",
          consumer_uid: "consumer-1",
          space_id: "space-1",
          workspace_id: "workspace-1",
        },
      })
      const imageMessage = imageBodies[0]!.message as Record<string, unknown>
      const imageContent = imageMessage.content as Array<Record<string, unknown>>
      expect(imageContent).toHaveLength(1)
      expect(imageContent[0]).toMatchObject({ sub_type: "biz/x_data_novel_raw_image_gen", type: "data" })
      expect(JSON.parse(String(imageContent[0]!.data))).toEqual({
        args: {},
        image_count: 1,
        image_resolution: "2K",
        model: "seedream_5.0",
        pippit_asset_ids: [],
        prompt: imageCall.prompt,
        ratio: "1:1",
      })

      const firstFrame = path.join(directory, "first.png")
      const lastFrame = path.join(directory, "last.png")
      const audio = path.join(directory, "sound.wav")
      await Promise.all([writeFile(firstFrame, png), writeFile(lastFrame, png), writeFile(audio, "RIFF-test")])
      const videoCall = call({
        operation_id: "video-operation",
        output: "video",
        output_directory: outputVideo,
        references: [
          { kind: "file", mime_type: "image/png", name: "first.png", node_id: "first", path: firstFrame, role: "first_frame" },
          { kind: "file", mime_type: "image/png", name: "last.png", node_id: "last", path: lastFrame, role: "last_frame" },
          { kind: "file", mime_type: "audio/wav", name: "sound.wav", node_id: "audio", path: audio, role: "audio" },
        ],
      })
      const video = await engine.generate(videoCall, visionVideoModel, new AbortController().signal)
      expect(videoSubmitCount).toBe(1)
      expect(videoQueryCount).toBe(2)
      expect(video[0]?.mimeType).toBe("video/mp4")
      expect(videoBodies[0]).toMatchObject({
        agent_name: "pippit_novel_video_part_agent",
        user_info: {
          app_id: "795647",
          consumer_uid: "consumer-1",
          space_id: "space-1",
          workspace_id: "workspace-1",
        },
      })
      expect(directVideoParameters(videoBodies[0]!)).toMatchObject({
        audios: [{ asset_id: "asset-3", pippit_asset_id: "pippit-3" }],
        generate_type: 1,
        images: [
          { asset_id: "asset-1", pippit_asset_id: "pippit-1" },
          { asset_id: "asset-2", pippit_asset_id: "pippit-2" },
        ],
        model: "seedance2.0_vision",
        resolution: "720p",
      })
      expect(uploadCount).toBe(3)
      expect(await operationStore.find("image-operation")).toMatchObject({ status: "submitted" })
      expect(await operationStore.find("video-operation")).toMatchObject({ status: "submitted" })
      const recordDirectory = path.join(directory, "state", ".operation-records")
      const recordFiles = await readdir(recordDirectory)
      expect(recordFiles).toHaveLength(2)
      for (const recordFile of recordFiles) {
        expect((await lstat(path.join(recordDirectory, recordFile))).mode & 0o077).toBe(0)
      }
    } finally {
      server.stop(true)
    }
  })

  test("does not submit or persist an operation when reference image registration is rejected or incomplete", async () => {
    const cases = [
      {
        name: "rejected",
        response: { ret: 4001, errmsg: "private upstream registration detail" },
      },
      {
        name: "missing-id",
        response: { data: {} },
      },
    ]

    for (const registrationCase of cases) {
      const directory = await mkdtemp(path.join(os.tmpdir(), `xiaoyunque-reference-${registrationCase.name}-`))
      directories.push(directory)
      const output = path.join(directory, "output")
      const referencePath = path.join(directory, "reference.png")
      await Promise.all([mkdir(output), writeFile(referencePath, png)])
      const requestedPaths: string[] = []
      let submitCount = 0
      const server = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        fetch: async (request): Promise<Response> => {
          const url = new URL(request.url)
          requestedPaths.push(url.pathname)
          if (url.pathname === "/api/web/v1/common/upload_file") {
            return Response.json({
              ret: 0,
              data: {
                asset_id: "everphoto-reference",
                download_url: `${url.origin}/uploaded-reference.png`,
              },
            })
          }
          if (url.pathname === "/api/biz/v1/asset/create_v2") {
            return Response.json(registrationCase.response)
          }
          if (url.pathname === "/api/biz/v1/agent/submit_run") submitCount += 1
          return new Response("unexpected", { status: 500 })
        },
      })
      const operationId = `reference-registration-${registrationCase.name}`
      const operationStore = new OperationStore(path.join(directory, "state", "operations.json"))
      const engine = new GenerationEngine({
        api: new XiaoYunqueApi(`http://127.0.0.1:${server.port}`),
        authorizer: { session: async () => testSession },
        operationStore,
        pollIntervalMs: 1,
      })
      try {
        const error = await engine.generate(call({
          operation_id: operationId,
          output: "image",
          output_directory: output,
          references: [{
            kind: "file",
            mime_type: "image/png",
            name: "reference.png",
            node_id: "reference-node",
            path: referencePath,
            role: "reference_image",
          }],
        }), imageModel, new AbortController().signal).catch((reason: unknown) => reason)

        expect(error).toBeInstanceOf(XiaoYunqueReferenceAssetRegistrationError)
        expect(requestedPaths).toEqual([
          "/api/web/v1/common/upload_file",
          "/api/biz/v1/asset/create_v2",
        ])
        expect(submitCount).toBe(0)
        expect(await operationStore.find(operationId)).toBeNull()
      } finally {
        server.stop(true)
      }
    }
  })

  test("uses one first frame as a normal image-to-video reference", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "xiaoyunque-first-frame-video-"))
    directories.push(directory)
    const output = path.join(directory, "output")
    const firstFrame = path.join(directory, "first.png")
    await Promise.all([mkdir(output), writeFile(firstFrame, png)])
    let uploadCount = 0
    let submittedBody: Record<string, unknown> | undefined
    let submittedTask: ReturnType<typeof taskFromSubmitBody> | undefined
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: async (request): Promise<Response> => {
        const url = new URL(request.url)
        if (url.pathname === "/api/web/v1/common/upload_file") {
          uploadCount += 1
          const form = await request.formData()
          expect(path.basename((form.get("file") as File | null)?.name ?? "")).toBe("first.png")
          expect(form.get("asset_type")).toBe("2")
          return Response.json({
            ret: 0,
            data: {
              asset_id: "first-frame-asset",
              download_url: `${url.origin}/uploaded-first.png`,
              pippit_asset_id: "pippit-first-frame",
            },
          })
        }
        const accountPreflight = await accountPreflightResponse(request)
        if (accountPreflight) return accountPreflight
        if (url.pathname === "/api/biz/v1/agent/submit_run") {
          submittedBody = await request.json() as Record<string, unknown>
          submittedTask = taskFromSubmitBody(submittedBody)
          return Response.json({ ret: 0, data: { accepted: true } })
        }
        if (url.pathname === "/api/biz/v1/agent/get_thread") {
          expect(await request.json()).toEqual({
            run_id: submittedTask?.runId,
            scopes: ["run_list.entry_list"],
            thread_id: submittedTask?.threadId,
          })
          return Response.json({
            ret: 0,
            data: {
              thread: {
                thread_id: submittedTask?.threadId,
                run_list: [{
                  entry_list: [artifactEntry("biz/x_data_video", `${url.origin}/result.mp4`)],
                  run_id: submittedTask?.runId,
                  state: "3",
                  thread_id: submittedTask?.threadId,
                }],
              },
            },
          })
        }
        if (url.pathname === "/result.mp4") return new Response(mp4, { headers: { "Content-Type": "video/mp4" } })
        return new Response("not found", { status: 404 })
      },
    })
    const store = new OperationStore(path.join(directory, "state", "operations.json"))
    const engine = new GenerationEngine({
      api: new XiaoYunqueApi(`http://127.0.0.1:${server.port}`),
      authorizer: { session: async () => testSession },
      operationStore: store,
      pollIntervalMs: 1,
    })
    try {
      const artifacts = await engine.generate(call({
        operation_id: "single-first-frame-video",
        output: "video",
        output_directory: output,
        references: [{
          kind: "file",
          mime_type: "image/png",
          name: "first.png",
          node_id: "ordinary-canvas-image-node",
          path: firstFrame,
          role: "first_frame",
        }],
      }), videoModel, new AbortController().signal)

      expect(artifacts[0]?.mimeType).toBe("video/mp4")
      expect(uploadCount).toBe(1)
      expect(submittedBody).toMatchObject({
        agent_name: "pippit_novel_video_part_agent",
      })
      const toolParameters = directVideoParameters(submittedBody!)
      expect(toolParameters).toMatchObject({
        images: [{ asset_id: "first-frame-asset", pippit_asset_id: "pippit-first-frame" }],
        model: "Seedance_2.0_mini_lite",
      })
      expect(Object.hasOwn(toolParameters, "generate_type")).toBeFalse()
      expect(await store.find("single-first-frame-video")).toMatchObject({ status: "submitted" })
    } finally {
      server.stop(true)
    }
  })

  test("rejects a last frame without a first frame before any API request", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "xiaoyunque-last-frame-only-"))
    directories.push(directory)
    const output = path.join(directory, "output")
    const lastFrame = path.join(directory, "last.png")
    await Promise.all([mkdir(output), writeFile(lastFrame, png)])
    let requestCount = 0
    const engine = new GenerationEngine({
      api: new XiaoYunqueApi("http://127.0.0.1", (async () => {
        requestCount += 1
        return new Response("unexpected", { status: 500 })
      }) as unknown as typeof fetch),
      authorizer: { session: async () => testSession },
      operationStore: new OperationStore(path.join(directory, "state", "operations.json")),
    })
    const generation = call({
      operation_id: "last-frame-only",
      output: "video",
      output_directory: output,
      references: [{
        kind: "file",
        mime_type: "image/png",
        name: "last.png",
        node_id: "ordinary-canvas-image-node",
        path: lastFrame,
        role: "last_frame",
      }],
    })

    const failure = await engine.generate(generation, videoModel, new AbortController().signal)
      .catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(XiaoYunqueGenerationInputError)
    expect((failure as XiaoYunqueGenerationInputError).publicMessage)
      .toBe("A video last frame requires exactly one first frame.")
    expect(requestCount).toBe(0)
  })

  test("rejects an operation-id replay with changed content", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "xiaoyunque-replay-"))
    directories.push(directory)
    const output = path.join(directory, "output")
    await mkdir(output)
    const store = new OperationStore(path.join(directory, "state", "operations.json"))
    await store.save("same", {
      createdAt: new Date().toISOString(),
      fingerprint: "different",
      output: "image",
      runId: "run",
      status: "submitted",
      threadId: "thread",
    })
    const engine = new GenerationEngine({
      api: new XiaoYunqueApi("http://127.0.0.1:9"),
      authorizer: { session: async () => testSession },
      operationStore: store,
    })
    await expect(engine.generate(
      call({ operation_id: "same", output: "image", output_directory: output }),
      imageModel,
      new AbortController().signal,
    ))
      .rejects.toThrow("different request")
  })

  test("rejects an operation-id replay with a different selected model", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "xiaoyunque-model-replay-"))
    directories.push(directory)
    const output = path.join(directory, "output")
    await mkdir(output)
    const generation = call({ operation_id: "same-model-operation", output: "video", output_directory: output })
    const store = new OperationStore(path.join(directory, "state", "operations.json"))
    await store.save(generation.operation_id, {
      createdAt: new Date().toISOString(),
      fingerprint: await fingerprintGenerationCall(generation, videoModel),
      output: "video",
      runId: "run",
      status: "submitted",
      threadId: "thread",
    })
    let authorizationCount = 0
    const engine = new GenerationEngine({
      api: new XiaoYunqueApi("http://127.0.0.1:9"),
      authorizer: {
        session: async () => {
          authorizationCount += 1
          return testSession
        },
      },
      operationStore: store,
    })

    await expect(engine.generate(generation, visionVideoModel, new AbortController().signal))
      .rejects.toThrow("different request")
    expect(authorizationCount).toBe(0)
  })

  test("serializes concurrent calls for one operation and submits it only once", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "xiaoyunque-concurrent-replay-"))
    directories.push(directory)
    const outputOne = path.join(directory, "output-one")
    const outputTwo = path.join(directory, "output-two")
    await Promise.all([mkdir(outputOne), mkdir(outputTwo)])
    const storePath = path.join(directory, "state", "operations.json")
    let submitCount = 0
    let submittedTask: ReturnType<typeof taskFromSubmitBody> | undefined
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: async (request) => {
        const url = new URL(request.url)
        const accountPreflight = await accountPreflightResponse(request)
        if (accountPreflight) return accountPreflight
        if (url.pathname === "/api/biz/v1/agent/submit_run") {
          submitCount += 1
          submittedTask = taskFromSubmitBody(await request.json() as Record<string, unknown>)
          expect(await new OperationStore(storePath).find("same-concurrent-operation"))
            .toMatchObject({ status: "submitting" })
          await Bun.sleep(20)
          return Response.json({ ret: 0, data: { accepted: true } })
        }
        if (url.pathname === "/api/biz/v1/agent/get_thread") {
          return Response.json({
            ret: 0,
            data: {
              thread: {
                thread_id: submittedTask?.threadId,
                run_list: [{
                  run_id: submittedTask?.runId,
                  thread_id: submittedTask?.threadId,
                  state: 3,
                  entry_list: [artifactEntry("biz/x_data_image", `${url.origin}/result.png`)],
                }],
              },
            },
          })
        }
        if (url.pathname === "/result.png") return new Response(png)
        return new Response("not found", { status: 404 })
      },
    })
    const engineOne = new GenerationEngine({
      api: new XiaoYunqueApi(`http://127.0.0.1:${server.port}`),
      authorizer: { session: async () => testSession },
      operationStore: new OperationStore(storePath, { lockPollIntervalMs: 1 }),
      pollIntervalMs: 1,
    })
    const engineTwo = new GenerationEngine({
      api: new XiaoYunqueApi(`http://127.0.0.1:${server.port}`),
      authorizer: { session: async () => testSession },
      operationStore: new OperationStore(storePath, { lockPollIntervalMs: 1 }),
      pollIntervalMs: 1,
    })
    const generation = call({
      operation_id: "same-concurrent-operation",
      output: "image",
      output_directory: outputOne,
    })
    try {
      const [first, second] = await Promise.all([
        engineOne.generate(generation, imageModel, new AbortController().signal),
        engineTwo.generate(
          { ...generation, output_directory: outputTwo },
          imageModel,
          new AbortController().signal,
        ),
      ])
      expect(first[0]?.mimeType).toBe("image/png")
      expect(second[0]?.mimeType).toBe("image/png")
      expect(submitCount).toBe(1)
      expect(await new OperationStore(storePath).find("same-concurrent-operation"))
        .toMatchObject({
          status: "submitted",
          runId: submittedTask?.runId,
          threadId: submittedTask?.threadId,
        })
    } finally {
      server.stop(true)
    }
  })

  test("fails closed on a submitting tombstone before authorization or API access", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "xiaoyunque-tombstone-"))
    directories.push(directory)
    const output = path.join(directory, "output")
    await mkdir(output)
    const generation = call({ operation_id: "uncertain-submit", output: "image", output_directory: output })
    const store = new OperationStore(path.join(directory, "state", "operations.json"))
    await store.save(generation.operation_id, {
      createdAt: new Date().toISOString(),
      fingerprint: await fingerprintGenerationCall(generation, imageModel),
      output: generation.output,
      status: "submitting",
    })
    let authorizationCount = 0
    let apiCount = 0
    const engine = new GenerationEngine({
      api: new XiaoYunqueApi("https://xyq.jianying.com", (async () => {
        apiCount += 1
        return Response.json({ ret: 0 })
      }) as unknown as typeof fetch),
      authorizer: {
        session: async () => {
          authorizationCount += 1
          return testSession
        },
      },
      operationStore: store,
    })

    await expect(engine.generate(generation, imageModel, new AbortController().signal))
      .rejects.toThrow("prior XiaoYunque submission may have been accepted")
    expect(authorizationCount).toBe(0)
    expect(apiCount).toBe(0)
  })

  test("persists a paid task before observing cancellation after submit", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "xiaoyunque-post-submit-cancel-"))
    directories.push(directory)
    const outputOne = path.join(directory, "output-one")
    const outputTwo = path.join(directory, "output-two")
    await Promise.all([mkdir(outputOne), mkdir(outputTwo)])
    const controller = new AbortController()
    let submitCount = 0
    let submittedTask: ReturnType<typeof taskFromSubmitBody> | undefined
    const fakeFetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : input)
      const accountPreflight = await accountPreflightResponse(url, init)
      if (accountPreflight) return accountPreflight
      if (url.pathname === "/api/biz/v1/agent/submit_run") {
        submitCount += 1
        submittedTask = taskFromSubmitBody(JSON.parse(String(init?.body)) as Record<string, unknown>)
        controller.abort()
        return Response.json({ ret: 0, data: { accepted: true } })
      }
      if (url.pathname === "/api/biz/v1/agent/get_thread") {
        return Response.json({
          ret: 0,
          data: {
            thread: {
              thread_id: submittedTask?.threadId,
              run_list: [{
                run_id: submittedTask?.runId,
                thread_id: submittedTask?.threadId,
                state: 3,
                entry_list: [artifactEntry("biz/x_data_image", "http://127.0.0.1/result.png")],
              }],
            },
          },
        })
      }
      if (url.pathname === "/result.png") return new Response(png)
      return new Response("not found", { status: 404 })
    }) as typeof fetch
    const store = new OperationStore(path.join(directory, "state", "operations.json"))
    const engine = new GenerationEngine({
      api: new XiaoYunqueApi("http://127.0.0.1", fakeFetch),
      authorizer: { session: async () => testSession },
      fetch: fakeFetch,
      operationStore: store,
      pollIntervalMs: 1,
    })
    const generation = call({
      operation_id: "cancelled-after-submit",
      output: "image",
      output_directory: outputOne,
    })

    await expect(engine.generate(generation, imageModel, controller.signal)).rejects.toMatchObject({ name: "AbortError" })
    expect(await store.find(generation.operation_id)).toMatchObject({
      runId: submittedTask?.runId,
      status: "submitted",
      threadId: submittedTask?.threadId,
    })
    const recovered = await engine.generate(
      { ...generation, output_directory: outputTwo },
      imageModel,
      new AbortController().signal,
    )
    expect(recovered[0]?.mimeType).toBe("image/png")
    expect(submitCount).toBe(1)
  })

  test("keeps a submitted operation through request timeouts and long-running pending states", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "xiaoyunque-long-poll-"))
    directories.push(directory)
    const output = path.join(directory, "output")
    await mkdir(output)
    const pendingPolls = 30
    let submitCount = 0
    let queryCount = 0
    let submittedTask: ReturnType<typeof taskFromSubmitBody> | undefined
    const fakeFetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : input)
      const accountPreflight = await accountPreflightResponse(url, init)
      if (accountPreflight) return accountPreflight
      if (url.pathname === "/api/biz/v1/agent/submit_run") {
        submitCount += 1
        submittedTask = taskFromSubmitBody(JSON.parse(String(init?.body)) as Record<string, unknown>)
        return Response.json({ ret: 0, data: { accepted: true } })
      }
      if (url.pathname === "/api/biz/v1/agent/get_thread") {
        queryCount += 1
        if (queryCount <= 2) {
          return new Promise<Response>((_resolve, reject) => {
            const requestSignal = init?.signal
            requestSignal?.addEventListener("abort", () => {
              reject(requestSignal.reason ?? new DOMException("Request aborted", "AbortError"))
            }, { once: true })
          })
        }
        const completed = queryCount > pendingPolls + 2
        return Response.json({
          ret: 0,
          data: {
            thread: {
              thread_id: submittedTask?.threadId,
              run_list: [{
                run_id: submittedTask?.runId,
                thread_id: submittedTask?.threadId,
                state: completed ? 3 : 2,
                entry_list: completed
                  ? [artifactEntry("biz/x_data_image", "http://127.0.0.1/result.png")]
                  : [],
              }],
            },
          },
        })
      }
      if (url.pathname === "/result.png") return new Response(png)
      return new Response("not found", { status: 404 })
    }) as typeof fetch
    const store = new OperationStore(path.join(directory, "state", "operations.json"))
    const engine = new GenerationEngine({
      api: new XiaoYunqueApi(
        "http://127.0.0.1",
        fakeFetch,
        { queryRequestTimeoutMs: 5 },
      ),
      authorizer: { session: async () => testSession },
      fetch: fakeFetch,
      operationStore: store,
      pollIntervalMs: 1,
    })
    const generation = call({
      operation_id: "long-running-operation",
      output: "image",
      output_directory: output,
    })

    const artifacts = await engine.generate(generation, imageModel, new AbortController().signal)

    expect(artifacts[0]?.mimeType).toBe("image/png")
    expect(queryCount).toBe(pendingPolls + 3)
    expect(submitCount).toBe(1)
    expect(await store.find(generation.operation_id)).toMatchObject({
      runId: submittedTask?.runId,
      status: "submitted",
      threadId: submittedTask?.threadId,
    })
  })

  test("distinguishes a rejected status observation from a rejected submission", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "xiaoyunque-observation-rejected-"))
    directories.push(directory)
    const output = path.join(directory, "output")
    await mkdir(output)
    const store = new OperationStore(path.join(directory, "state", "operations.json"))
    let submitCount = 0
    let queryCount = 0
    const api = {
      async query() {
        queryCount += 1
        throw new XiaoYunqueRequestRejectedError(
          "private status response",
          "upstream-envelope-rejected",
        )
      },
      async submitImage() {
        submitCount += 1
        return { runId: "accepted-run", threadId: "accepted-thread" }
      },
    } as unknown as XiaoYunqueApi
    const engine = new GenerationEngine({
      api,
      authorizer: { session: async () => testSession },
      operationStore: store,
      pollIntervalMs: 1,
    })
    const generation = call({
      operation_id: "observation-rejected-operation",
      output: "image",
      output_directory: output,
    })

    const failure = await engine.generate(generation, imageModel, new AbortController().signal)
      .catch((error: unknown) => error)

    expect(failure).toBeInstanceOf(XiaoYunqueObservationRejectedError)
    expect((failure as XiaoYunqueObservationRejectedError).upstreamDiagnosticCode)
      .toBe("upstream-envelope-rejected")
    expect(String(failure)).not.toContain("private status response")
    expect(submitCount).toBe(1)
    expect(queryCount).toBe(3)
    expect(await store.find(generation.operation_id)).toMatchObject({
      runId: "accepted-run",
      status: "submitted",
      threadId: "accepted-thread",
    })

    let submitStageQueryCount = 0
    const submitStageApi = {
      async query() {
        submitStageQueryCount += 1
        throw new Error("query should not run")
      },
      async submitImage(options: { beforeSubmit?: () => Promise<void> }) {
        await options.beforeSubmit?.()
        throw new XiaoYunqueRequestRejectedError(
          "private submit response",
          "upstream-http-rejected",
        )
      },
    } as unknown as XiaoYunqueApi
    const submitStageCall = call({
      operation_id: "submit-rejected-operation",
      output: "image",
      output_directory: output,
    })
    const submitStageFailure = await new GenerationEngine({
      api: submitStageApi,
      authorizer: { session: async () => testSession },
      operationStore: store,
      pollIntervalMs: 1,
    }).generate(submitStageCall, imageModel, new AbortController().signal)
      .catch((error: unknown) => error)

    expect(submitStageFailure).toBeInstanceOf(XiaoYunqueRequestRejectedError)
    expect(submitStageFailure).not.toBeInstanceOf(XiaoYunqueObservationRejectedError)
    expect(submitStageQueryCount).toBe(0)
    expect(await store.find(submitStageCall.operation_id)).toMatchObject({ status: "submitting" })
  })

  for (const terminal of [
    { message: "video generation failed at the vendor", state: "4" },
    { message: "XiaoYunque video generation was cancelled", state: "5" },
    { message: "XiaoYunque video generation requires additional input", state: "6" },
    { message: "XiaoYunque video generation was interrupted for human input", state: "9" },
  ] as const) {
    test(`does not retry video terminal state ${terminal.state}`, async () => {
      const directory = await mkdtemp(path.join(os.tmpdir(), `xiaoyunque-video-terminal-${terminal.state}-`))
      directories.push(directory)
      const output = path.join(directory, "output")
      await mkdir(output)
      let queryCount = 0
      let submittedTask: ReturnType<typeof taskFromSubmitBody> | undefined
      const fakeFetch = (async (input: string | URL | Request, init?: RequestInit) => {
        const url = new URL(input instanceof Request ? input.url : input)
        const accountPreflight = await accountPreflightResponse(url, init)
        if (accountPreflight) return accountPreflight
        if (url.pathname === "/api/biz/v1/agent/submit_run") {
          submittedTask = taskFromSubmitBody(JSON.parse(String(init?.body)) as Record<string, unknown>)
          return Response.json({ ret: 0, data: { accepted: true } })
        }
        if (url.pathname === "/api/biz/v1/agent/get_thread") {
          queryCount += 1
          return Response.json({
            ret: 0,
            data: {
              thread: {
                thread_id: submittedTask?.threadId,
                run_list: [{
                  entry_list: [],
                  ...(terminal.state === "4" ? { fail_reason: { message: terminal.message } } : {}),
                  run_id: submittedTask?.runId,
                  state: terminal.state,
                  thread_id: submittedTask?.threadId,
                }],
              },
            },
          })
        }
        return new Response("not found", { status: 404 })
      }) as typeof fetch
      const engine = new GenerationEngine({
        api: new XiaoYunqueApi("http://127.0.0.1", fakeFetch),
        authorizer: { session: async () => testSession },
        operationStore: new OperationStore(path.join(directory, "state", "operations.json")),
        pollIntervalMs: 1,
      })

      const failure = await engine.generate(call({
        operation_id: `video-terminal-${terminal.state}`,
        output: "video",
        output_directory: output,
      }), videoModel, new AbortController().signal).catch((error: unknown) => error)

      expect(failure).toBeInstanceOf(Error)
      expect((failure as Error).message).toBe(terminal.message)
      expect(queryCount).toBe(1)
    })
  }

  test("turns the exact unsupported raw-image terminal diagnostic into a safe typed failure", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "xiaoyunque-unsupported-image-model-"))
    directories.push(directory)
    const output = path.join(directory, "output")
    await mkdir(output)
    const api = {
      async query(task: { runId: string; threadId: string }) {
        return {
          ...task,
          error: "unsupported image_model_name: nova2",
          imageUrls: [],
          state: 4,
          terminalDiagnosticCode: "unsupported-image-model",
          videoUrls: [],
        }
      },
      async submitImage(options: { beforeSubmit?: () => Promise<void> }) {
        await options.beforeSubmit?.()
        return { runId: "accepted-run", threadId: "accepted-thread" }
      },
    } as unknown as XiaoYunqueApi
    const failure = await new GenerationEngine({
      api,
      authorizer: { session: async () => testSession },
      operationStore: new OperationStore(path.join(directory, "state", "operations.json")),
      pollIntervalMs: 1,
    }).generate(call({
      operation_id: "unsupported-image-model-operation",
      output: "image",
      output_directory: output,
    }), imageModel, new AbortController().signal).catch((error: unknown) => error)

    expect(failure).toBeInstanceOf(XiaoYunqueUnsupportedImageModelError)
    expect((failure as Error).message).not.toContain("nova2")
    expect((failure as Error).message).not.toContain("image_model_name")
  })

  for (const terminal of [
    { message: "XiaoYunque image generation requires additional input", state: 6 },
    { message: "XiaoYunque image generation was interrupted for human input", state: 9 },
  ] as const) {
    test(`fails fast when the image thread enters unsupported state ${terminal.state}`, async () => {
      const directory = await mkdtemp(path.join(os.tmpdir(), `xiaoyunque-image-terminal-${terminal.state}-`))
      directories.push(directory)
      const output = path.join(directory, "output")
      await mkdir(output)
      let queryCount = 0
      let submittedTask: ReturnType<typeof taskFromSubmitBody> | undefined
      const fakeFetch = (async (input: string | URL | Request, init?: RequestInit) => {
        const url = new URL(input instanceof Request ? input.url : input)
        const accountPreflight = await accountPreflightResponse(url, init)
        if (accountPreflight) return accountPreflight
        if (url.pathname === "/api/biz/v1/agent/submit_run") {
          submittedTask = taskFromSubmitBody(JSON.parse(String(init?.body)) as Record<string, unknown>)
          return Response.json({ ret: 0, data: { accepted: true } })
        }
        if (url.pathname === "/api/biz/v1/agent/get_thread") {
          queryCount += 1
          return Response.json({
            ret: 0,
            data: {
              thread: {
                run_list: [{
                  entry_list: [],
                  run_id: submittedTask?.runId,
                  state: terminal.state,
                  thread_id: submittedTask?.threadId,
                }],
                thread_id: submittedTask?.threadId,
              },
            },
          })
        }
        return new Response("not found", { status: 404 })
      }) as typeof fetch
      const engine = new GenerationEngine({
        api: new XiaoYunqueApi("http://127.0.0.1", fakeFetch),
        authorizer: { session: async () => testSession },
        operationStore: new OperationStore(path.join(directory, "state", "operations.json")),
        pollIntervalMs: 1,
      })

      const failure = await engine.generate(call({
        operation_id: `image-terminal-${terminal.state}`,
        output: "image",
        output_directory: output,
      }), imageModel, new AbortController().signal).catch((error: unknown) => error)

      expect(failure).toBeInstanceOf(Error)
      expect((failure as Error).message).toBe(terminal.message)
      expect(queryCount).toBe(1)
    })
  }

  test("removes the abort listener after a normal poll delay", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "xiaoyunque-poll-listener-"))
    directories.push(directory)
    const output = path.join(directory, "output")
    await mkdir(output)
    let queryCount = 0
    const api = {
      submitImage: async () => ({ runId: "run", threadId: "thread" }),
      query: async () => {
        queryCount += 1
        if (queryCount === 1) {
          return { imageUrls: [], runId: "run", state: 1, threadId: "thread", videoUrls: [] }
        }
        throw new Error("stop after delay")
      },
    } as unknown as XiaoYunqueApi
    const engine = new GenerationEngine({
      api,
      authorizer: { session: async () => testSession },
      operationStore: new OperationStore(path.join(directory, "state", "operations.json")),
      pollIntervalMs: 1,
    })
    const nativeSignal = new AbortController().signal
    const abortListeners = new Set<EventListenerOrEventListenerObject>()
    const signal = new Proxy(nativeSignal, {
      get(target, property) {
        if (property === "addEventListener") {
          return (type: string, listener: EventListenerOrEventListenerObject, options?: boolean | AddEventListenerOptions) => {
            if (type === "abort") abortListeners.add(listener)
            target.addEventListener(type, listener, options)
          }
        }
        if (property === "removeEventListener") {
          return (type: string, listener: EventListenerOrEventListenerObject, options?: boolean | EventListenerOptions) => {
            if (type === "abort") abortListeners.delete(listener)
            target.removeEventListener(type, listener, options)
          }
        }
        const value = Reflect.get(target, property, target) as unknown
        return typeof value === "function" ? value.bind(target) : value
      },
    })

    await expect(engine.generate(call({
      operation_id: "poll-listener-cleanup",
      output: "image",
      output_directory: output,
    }), imageModel, signal)).rejects.toThrow("stop after delay")
    expect(queryCount).toBe(4)
    expect(abortListeners.size).toBe(0)
  })
})
