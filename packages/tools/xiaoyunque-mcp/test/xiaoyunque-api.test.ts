import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import {
  type RemoteTask,
  type UploadedAsset,
  type VideoSubmitOptions,
  XiaoYunqueApi,
  XiaoYunqueAuthenticationError,
  XiaoYunqueQueryTimeoutError,
  XiaoYunqueReferenceAssetRegistrationError,
  XiaoYunqueRequestRejectedError,
} from "../src/xiaoyunque-api.ts"
import {
  type StoredWebSession,
  webSessionSchema,
} from "../src/web-session-store.ts"

const task: RemoteTask = { runId: "run-123", threadId: "thread-456" }
const signal = new AbortController().signal
const directories: string[] = []
const servers: Array<ReturnType<typeof Bun.serve>> = []

const session: StoredWebSession = {
  authorizedAt: 1_700_000_000_000,
  cookies: [{
    domain: "",
    name: "sessionid_pippitcn_web",
    path: "/",
    secure: true,
    value: "private-cookie-value",
  }],
  revision: "12345678-1234-4123-8123-123456789abc",
  schema: webSessionSchema,
}

const imageAsset: UploadedAsset = {
  assetId: "asset-image",
  metadata: {
    format: "png",
    frameCount: 1,
    height: 720,
    md5: "0123456789abcdef",
    mime: "image/png",
    ratio: "1280:720",
    size: 8,
    width: 1280,
  },
  name: "reference.png",
  pippitAssetId: "pippit-image",
  url: "https://cdn.example.test/reference.png",
}

afterEach(async () => {
  for (const server of servers.splice(0)) server.stop(true)
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { force: true, recursive: true })))
})

function apiFor(
  responder: (url: URL, init: RequestInit | undefined) => Response | Promise<Response>,
) {
  return new XiaoYunqueApi("https://xyq.jianying.com", (async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input)
    return responder(url, init)
  }) as typeof fetch)
}

function expectWebHeaders(headersInit: HeadersInit | undefined) {
  const headers = new Headers(headersInit)
  expect(headers.get("cookie")).toBe("sessionid_pippitcn_web=private-cookie-value")
  expect(headers.get("appvr")).toBe("1.1.4")
  expect(headers.get("entrance-from")).toBe("web")
  expect(headers.get("appid")).toBe("795647")
  expect(headers.get("pf")).toBe("7")
}

function odinUserInfoResponse() {
  return Response.json({
    ret: "0",
    data: {
      user_id: "consumer-1",
    },
  })
}

function userWorkspaceResponse() {
  return Response.json({
    ret: "0",
    data: {
      space_id: "space-1",
      workspace_id: "workspace-1",
    },
  })
}

function successfulRunResponse() {
  return Response.json({ ret: "0", data: { accepted: true } })
}

async function captureVideoToolParam(options: VideoSubmitOptions) {
  let toolParam: Record<string, unknown> | undefined
  const api = apiFor(async (url, init) => {
    if (url.pathname === "/api/biz/v1/common/get_odin_user_info") return odinUserInfoResponse()
    if (url.pathname === "/api/web/v1/workspace/get_user_workspace") return userWorkspaceResponse()
    expect(url.pathname).toBe("/api/biz/v1/agent/submit_run")
    const body = JSON.parse(String(init?.body)) as Record<string, any>
    const directCall = JSON.parse(body.message.content[0].data) as { param: string; tool_name: string }
    expect(directCall.tool_name).toBe("biz/x_tool_name_video_part")
    toolParam = JSON.parse(directCall.param) as Record<string, unknown>
    return successfulRunResponse()
  })
  await api.submitVideo(options, session, signal)
  return toolParam!
}

function artifactEntry(subType: "biz/x_data_image" | "biz/x_data_video", media: Record<string, unknown>) {
  return {
    type: 2,
    artifact: {
      content: [{
        sub_type: subType,
        data: JSON.stringify({ [subType === "biz/x_data_image" ? "image" : "video"]: media }),
      }],
    },
  }
}

function threadResponse(run: Record<string, unknown>, threadId = task.threadId) {
  return Response.json({
    ret: "0",
    data: {
      thread: {
        thread_id: threadId,
        run_list: [run],
      },
    },
  })
}

describe("XiaoYunque first-party Web generation API", () => {
  test("uploads references with the Cookie session, Web headers, and media asset type", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "xiaoyunque-web-upload-"))
    directories.push(directory)
    const referencePath = path.join(directory, "reference.png")
    await writeFile(referencePath, Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]))

    let requestCount = 0
    const api = apiFor(async (url, init) => {
      requestCount += 1
      expect(url.pathname).toBe("/api/web/v1/common/upload_file")
      expect(init?.method).toBe("POST")
      expectWebHeaders(init?.headers)
      expect(new Headers(init?.headers).has("authorization")).toBe(false)
      expect(new Headers(init?.headers).has("content-type")).toBe(false)
      const body = init?.body as FormData
      expect(body.get("asset_type")).toBe("2")
      const file = body.get("file")
      expect(file).toBeInstanceOf(File)
      expect((file as File).name).toBe("reference.png")
      return Response.json({
        ret: 0,
        data: {
          asset_id: "asset-image",
          download_url: "https://cdn.example.test/reference.png",
          format: "png",
          height: "720",
          md5: "0123456789abcdef",
          mime: "image/png",
          pippit_asset_id: "pippit-image",
          size: "8",
          width: "1280",
        },
      })
    })

    expect(await api.upload({
      kind: "file",
      mime_type: "image/png",
      name: "reference.png",
      node_id: "node-image",
      path: referencePath,
      role: "reference_image",
    }, session, signal)).toEqual(imageAsset)
    expect(requestCount).toBe(1)
  })

  test("registers an uploaded EverPhoto image when upload_file returns a blank Pippit asset id", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "xiaoyunque-web-register-upload-"))
    directories.push(directory)
    const referencePath = path.join(directory, "reference.png")
    await writeFile(referencePath, Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]))

    for (const directPippitAssetId of ["", " \t "]) {
      const requests: string[] = []
      const api = apiFor((url, init) => {
        requests.push(url.pathname)
        expectWebHeaders(init?.headers)
        if (url.pathname === "/api/web/v1/common/upload_file") {
          return Response.json({
            ret: 0,
            data: {
              asset_id: "asset-image",
              download_url: "https://cdn.example.test/reference.png",
              format: "png",
              height: "720",
              md5: "0123456789abcdef",
              mime: "image/png",
              pippit_asset_id: directPippitAssetId,
              size: "8",
              width: "1280",
            },
          })
        }
        expect(url.pathname).toBe("/api/biz/v1/asset/create_v2")
        expect(init?.method).toBe("POST")
        expect(JSON.parse(String(init?.body))).toEqual({
          asset_source_type: 3,
          asset_source_id: "asset-image",
          asset_type: 1,
          Base: { Client: "web" },
        })
        return Response.json({
          data: { PippitAssetID: "pippit-image" },
        })
      })

      expect(await api.upload({
        kind: "file",
        mime_type: "image/png",
        name: "reference.png",
        node_id: "node-image",
        path: referencePath,
        role: "reference_image",
      }, session, signal)).toEqual(imageAsset)
      expect(requests).toEqual([
        "/api/web/v1/common/upload_file",
        "/api/biz/v1/asset/create_v2",
      ])
    }
  })

  test("classifies failed or incomplete reference image registration without leaking upstream details", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "xiaoyunque-web-register-failure-"))
    directories.push(directory)
    const referencePath = path.join(directory, "reference.png")
    await writeFile(referencePath, Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]))
    const reference = {
      kind: "file",
      mime_type: "image/png",
      name: "reference.png",
      node_id: "node-image",
      path: referencePath,
      role: "reference_image",
    } as const
    const uploadResponse = () => Response.json({
      ret: 0,
      data: {
        asset_id: "asset-image",
        download_url: "https://cdn.example.test/reference.png",
      },
    })
    const rejected = apiFor((url) => url.pathname === "/api/web/v1/common/upload_file"
      ? uploadResponse()
      : Response.json({ ret: 4001, errmsg: "private upstream registration detail" }))
    const incomplete = apiFor((url) => url.pathname === "/api/web/v1/common/upload_file"
      ? uploadResponse()
      : Response.json({ ret: 0, data: { PippitAssetID: "" } }))

    for (const api of [rejected, incomplete]) {
      const error = await api.upload(reference, session, signal).catch((reason: unknown) => reason)
      expect(error).toBeInstanceOf(XiaoYunqueReferenceAssetRegistrationError)
      expect((error as XiaoYunqueReferenceAssetRegistrationError).referenceType).toBe("image")
      expect(String(error)).toBe(
        "XiaoYunqueReferenceAssetRegistrationError: XiaoYunque reference image asset registration failed",
      )
      expect(String(error)).not.toContain("private upstream registration detail")
      expect(String(error)).not.toContain("asset-image")
    }
  })

  test("maps video and audio references to the first-party upload asset types", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "xiaoyunque-web-media-upload-"))
    directories.push(directory)
    const videoPath = path.join(directory, "reference.mp4")
    const audioPath = path.join(directory, "reference.mp3")
    await writeFile(videoPath, Uint8Array.from([0, 0, 0, 16, 102, 116, 121, 112]))
    await writeFile(audioPath, Uint8Array.from([73, 68, 51]))
    const seenTypes: string[] = []
    const api = apiFor((_url, init) => {
      const body = init?.body as FormData
      seenTypes.push(String(body.get("asset_type")))
      return Response.json({
        ret: "0",
        data: {
          asset_id: `asset-${seenTypes.length}`,
          download_url: `https://cdn.example.test/reference-${seenTypes.length}`,
          pippit_asset_id: `pippit-${seenTypes.length}`,
        },
      })
    })

    await api.upload({
      kind: "file",
      mime_type: "video/mp4",
      name: "reference.mp4",
      node_id: "video-node",
      path: videoPath,
      role: "reference_video",
    }, session, signal)
    await api.upload({
      kind: "file",
      mime_type: "audio/mpeg",
      name: "reference.mp3",
      node_id: "audio-node",
      path: audioPath,
      role: "audio",
    }, session, signal)

    expect(seenTypes).toEqual(["1", "4"])
  })

  test("registers an uploaded EverPhoto video with the video AssetCreateV2 type", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "xiaoyunque-web-register-video-"))
    directories.push(directory)
    const referencePath = path.join(directory, "reference.mp4")
    await writeFile(referencePath, Uint8Array.from([0, 0, 0, 16, 102, 116, 121, 112]))
    const requests: string[] = []
    const api = apiFor((url, init) => {
      requests.push(url.pathname)
      expectWebHeaders(init?.headers)
      if (url.pathname === "/api/web/v1/common/upload_file") {
        const body = init?.body as FormData
        expect(body.get("asset_type")).toBe("1")
        return Response.json({
          ret: 0,
          data: {
            asset_id: "asset-video",
            download_url: "https://cdn.example.test/reference.mp4",
            duration_ms: 5_000,
            pippit_asset_id: " ",
          },
        })
      }
      expect(url.pathname).toBe("/api/biz/v1/asset/create_v2")
      expect(init?.method).toBe("POST")
      expect(JSON.parse(String(init?.body))).toEqual({
        asset_source_type: 3,
        asset_source_id: "asset-video",
        asset_type: 2,
        Base: { Client: "web" },
      })
      return Response.json({
        ret: "0",
        data: { PippitAssetID: "pippit-video" },
      })
    })

    expect(await api.upload({
      kind: "file",
      mime_type: "video/mp4",
      name: "reference.mp4",
      node_id: "video-node",
      path: referencePath,
      role: "reference_video",
    }, session, signal)).toEqual({
      assetId: "asset-video",
      metadata: { durationMilliseconds: 5_000 },
      name: "reference.mp4",
      pippitAssetId: "pippit-video",
      url: "https://cdn.example.test/reference.mp4",
    })
    expect(requests).toEqual([
      "/api/web/v1/common/upload_file",
      "/api/biz/v1/asset/create_v2",
    ])
  })

  test("classifies failed reference video registration without leaking upstream details", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "xiaoyunque-web-register-video-failure-"))
    directories.push(directory)
    const referencePath = path.join(directory, "reference.mp4")
    await writeFile(referencePath, Uint8Array.from([0, 0, 0, 16, 102, 116, 121, 112]))
    const api = apiFor((url) => url.pathname === "/api/web/v1/common/upload_file"
      ? Response.json({
          ret: 0,
          data: {
            asset_id: "asset-video",
            download_url: "https://cdn.example.test/reference.mp4",
          },
        })
      : Response.json({ ret: 4001, errmsg: "private upstream video detail" }))

    const error = await api.upload({
      kind: "file",
      mime_type: "video/mp4",
      name: "reference.mp4",
      node_id: "video-node",
      path: referencePath,
      role: "reference_video",
    }, session, signal).catch((reason: unknown) => reason)

    expect(error).toBeInstanceOf(XiaoYunqueReferenceAssetRegistrationError)
    expect((error as XiaoYunqueReferenceAssetRegistrationError).referenceType).toBe("video")
    expect(String(error)).toBe(
      "XiaoYunqueReferenceAssetRegistrationError: XiaoYunque reference video asset registration failed",
    )
    expect(String(error)).not.toContain("private upstream video detail")
    expect(String(error)).not.toContain("asset-video")
  })

  test("submits one image through the first-party Canvas image flow", async () => {
    let submitBabiParam: Record<string, unknown> | undefined
    let submitBody: Record<string, unknown> | undefined
    const ordering: string[] = []
    const api = apiFor(async (url, init) => {
      expectWebHeaders(init?.headers)
      if (url.pathname === "/api/biz/v1/common/get_odin_user_info") {
        ordering.push("odin-user-info")
        expect(init?.method).toBe("POST")
        expect(JSON.parse(String(init?.body))).toEqual({})
        return odinUserInfoResponse()
      }
      if (url.pathname === "/api/web/v1/workspace/get_user_workspace") {
        ordering.push("user-workspace")
        expect(init?.method).toBe("POST")
        expect(JSON.parse(String(init?.body))).toEqual({ uid: "consumer-1" })
        return userWorkspaceResponse()
      }
      expect(url.pathname).toBe("/api/biz/v1/agent/submit_run")
      submitBabiParam = JSON.parse(url.searchParams.get("babi_param") ?? "null")
      ordering.push("submit")
      submitBody = JSON.parse(String(init?.body)) as Record<string, unknown>
      return successfulRunResponse()
    })

    const submitted = await api.submitImage({
      assets: [
        imageAsset,
        { ...imageAsset, assetId: "duplicate-image", name: "duplicate.png" },
      ],
      beforeSubmit: async () => {
        ordering.push("before-submit")
      },
      model: "seedream_4.5",
      prompt: "  draw a lighthouse\n\twith soft blue moonlight  ",
      ratio: "16:9",
      resolution: "4k",
    }, session, signal)

    expect(submitted.runId).toMatch(/^[0-9a-f-]{36}$/)
    expect(submitted.threadId).toMatch(/^[0-9a-f-]{36}$/)
    expect(ordering).toEqual(["odin-user-info", "user-workspace", "before-submit", "submit"])
    expect(submitBabiParam).toEqual({
      edit_type: "image_generation",
      enter_from: "web",
      scene_lv1: "ai_agent",
      scene_lv2: "front_tool",
      section_id: submitted.runId,
      tab_name: "canvas",
      tool_id: "pippit_novel_agent_cn_v2",
    })
    const body = submitBody as Record<string, any>
    expect(body.agent_name).toBe("pippit_novel_agent_cn_v2")
    expect(body.entrance_from).toBe("web")
    expect(body.user_info).toEqual({
      app_id: "795647",
      consumer_uid: "consumer-1",
      space_id: "space-1",
      workspace_id: "workspace-1",
    })
    expect(body.message).toMatchObject({
      message_id: "",
      role: "user",
      run_id: submitted.runId,
      thread_id: submitted.threadId,
    })
    expect(body.message.created_at).toEqual(expect.any(Number))
    expect(body.message.content).toHaveLength(1)
    expect(body.message.content[0]).toMatchObject({
      sub_type: "biz/x_data_novel_raw_image_gen",
      type: "data",
    })
    expect(JSON.parse(body.message.content[0].data)).toEqual({
      args: {},
      image_count: 1,
      image_resolution: "4K",
      model: "seedream_4.5",
      pippit_asset_ids: ["pippit-image"],
      prompt: "draw a lighthouse\n\twith soft blue moonlight",
      ratio: "16:9",
    })
    expect(typeof body.run_extra).toBe("string")
    expect(JSON.parse(body.run_extra)).toMatchObject({
      client_extra: {
        edit_type: "image_generation",
        entrance_from: "web",
        position: "canvas",
        run_source: "image-generation-submit",
        tab_name: "canvas",
        target: "image",
      },
      babi_param: {
        edit_type: "image_generation",
        enter_from: "web",
        generate_id: submitted.runId,
        scene_lv1: "ai_agent",
        scene_lv2: "front_tool",
        section_id: submitted.runId,
        tab_name: "canvas",
        tool_id: "pippit_novel_agent_cn_v2",
      },
    })
  })

  test("submits video through the current Canvas direct video-part tool", async () => {
    let submitBabiParam: Record<string, unknown> | undefined
    let submitBody: Record<string, any> | undefined
    const api = apiFor(async (url, init) => {
      if (url.pathname === "/api/biz/v1/common/get_odin_user_info") {
        expect(init?.method).toBe("POST")
        expect(JSON.parse(String(init?.body))).toEqual({})
        return odinUserInfoResponse()
      }
      if (url.pathname === "/api/web/v1/workspace/get_user_workspace") {
        expect(init?.method).toBe("POST")
        expect(JSON.parse(String(init?.body))).toEqual({ uid: "consumer-1" })
        return userWorkspaceResponse()
      }
      expect(url.pathname).toBe("/api/biz/v1/agent/submit_run")
      submitBabiParam = JSON.parse(url.searchParams.get("babi_param") ?? "null")
      submitBody = JSON.parse(String(init?.body))
      return successfulRunResponse()
    })

    const submitted = await api.submitVideo({
      audioAssets: [],
      durationSeconds: 10,
      generateType: 1,
      imageAssets: [imageAsset],
      model: "Seedance_2.0_mini_lite",
      prompt: "  animate the lighthouse  ",
      videoAssets: [],
    }, session, signal)

    const body = submitBody!
    expect(submitBabiParam).toEqual({
      edit_type: "video_part",
      enter_from: "web",
      scene_lv1: "ai_agent",
      scene_lv2: "front_tool",
      section_id: submitted.runId,
      tab_name: "canvas",
      tool_id: "pippit_novel_video_part_agent",
    })
    expect(body.agent_name).toBe("pippit_novel_video_part_agent")
    expect(body.user_info).toEqual({
      app_id: "795647",
      consumer_uid: "consumer-1",
      space_id: "space-1",
      workspace_id: "workspace-1",
    })
    const content = body.message.content[0]
    expect(content).toMatchObject({
      hidden: false,
      is_thought: false,
      sub_type: "biz/x_data_direct_tool_call_req",
      type: "data",
    })
    const directCall = JSON.parse(content.data)
    expect(directCall.tool_name).toBe("biz/x_tool_name_video_part")
    expect(JSON.parse(directCall.param)).toEqual({
      audios: [],
      duration_sec: 10,
      generate_type: 1,
      images: [{
        asset_id: "asset-image",
        metadata: {
          format: "png",
          frame_cnt: 1,
          height: 720,
          md5: "0123456789abcdef",
          mime: "image/png",
          name: "reference.png",
          ratio: "1280:720",
          size: 8,
          width: 1280,
        },
        name: "reference.png",
        pippit_asset_id: "pippit-image",
        url: "https://cdn.example.test/reference.png",
      }],
      language: "zh",
      model: "Seedance_2.0_mini_lite",
      prompt: "animate the lighthouse",
      ratio: "16:9",
      videos: [],
    })
    expect(Object.hasOwn(JSON.parse(directCall.param), "resolution")).toBeFalse()
    const runExtra = JSON.parse(body.run_extra)
    expect(runExtra.client_extra).toEqual({
      edit_type: "video_part",
      entrance_from: "web",
      position: "canvas",
      run_source: "video_part",
      tab_name: "canvas",
      target: "video",
    })
    expect(runExtra).toMatchObject({
      client_extra: {
        edit_type: "video_part",
        entrance_from: "web",
        position: "canvas",
        run_source: "video_part",
        tab_name: "canvas",
        target: "video",
      },
      babi_param: {
        edit_type: "video_part",
        enter_from: "web",
        generate_id: submitted.runId,
        scene_lv1: "ai_agent",
        scene_lv2: "front_tool",
        section_id: submitted.runId,
        tab_name: "canvas",
        tool_id: "pippit_novel_video_part_agent",
      },
    })
  })

  test("matches current model-specific immersive-video parameter shapes", async () => {
    for (const model of ["Seedance_2.0_mini_lite", "Seedance_2.0_mini"] as const) {
      const parameters = await captureVideoToolParam({
        audioAssets: [],
        imageAssets: [],
        model,
        prompt: "animate a paper bird",
        resolution: "1080p",
        videoAssets: [],
      })
      expect(parameters.model).toBe(model)
      expect(Object.hasOwn(parameters, "resolution")).toBeFalse()
      expect(Object.keys(parameters).sort()).toEqual([
        "audios",
        "duration_sec",
        "images",
        "language",
        "model",
        "prompt",
        "ratio",
        "videos",
      ])
    }

    const standardParameters = await captureVideoToolParam({
      audioAssets: [],
      imageAssets: [],
      model: "seedance2.0_direct",
      prompt: "animate a paper bird",
      resolution: "1080p",
      videoAssets: [],
    })
    expect(standardParameters.resolution).toBe("1080p")
    expect(Object.hasOwn(standardParameters, "imitation_videos")).toBeFalse()
    expect(Object.keys(standardParameters).sort()).toEqual([
      "audios",
      "duration_sec",
      "images",
      "language",
      "model",
      "prompt",
      "ratio",
      "resolution",
      "videos",
    ])

    const seedance15Parameters = await captureVideoToolParam({
      audioAssets: [],
      imageAssets: [],
      model: "seedance1.5_direct",
      prompt: "animate a paper bird",
      videoAssets: [],
    })
    expect(Object.hasOwn(seedance15Parameters, "imitation_videos")).toBeFalse()
    expect(seedance15Parameters.videos).toEqual([])
    expect(seedance15Parameters.audios).toEqual([])
    expect(Object.keys(seedance15Parameters).sort()).toEqual([
      "audios",
      "duration_sec",
      "images",
      "language",
      "model",
      "prompt",
      "ratio",
      "resolution",
      "videos",
    ])

    const seedance10Parameters = await captureVideoToolParam({
      audioAssets: [],
      imageAssets: [imageAsset],
      model: "Seedance_1.0_fast",
      prompt: "animate a paper bird",
      videoAssets: [],
    })
    expect(seedance10Parameters).toMatchObject({
      images: [expect.objectContaining({ asset_id: "asset-image" })],
      model: "Seedance_1.0_fast",
      resolution: "720p",
    })
    expect(Object.hasOwn(seedance10Parameters, "imitation_videos")).toBeFalse()
    expect(Object.hasOwn(seedance10Parameters, "videos")).toBeFalse()
    expect(Object.hasOwn(seedance10Parameters, "audios")).toBeFalse()
    expect(Object.hasOwn(seedance10Parameters, "generate_type")).toBeFalse()
    expect(Object.keys(seedance10Parameters).sort()).toEqual([
      "duration_sec",
      "images",
      "language",
      "model",
      "prompt",
      "ratio",
      "resolution",
    ])
  })

  test("rejects unsupported Seedance 1.0 Fast inputs before submission", async () => {
    let requestCount = 0
    const api = apiFor(() => {
      requestCount += 1
      throw new Error("request should not be sent")
    })
    const cases: Array<{ expected: string; options: Partial<VideoSubmitOptions> }> = [
      {
        expected: "accepts at most 1 reference image",
        options: { imageAssets: [imageAsset, imageAsset] },
      },
      {
        expected: "does not accept reference videos",
        options: { videoAssets: [imageAsset] },
      },
      {
        expected: "does not accept reference audio",
        options: { audioAssets: [imageAsset] },
      },
      {
        expected: "does not accept first and last frames",
        options: { generateType: 1 },
      },
    ]
    for (const { expected, options } of cases) {
      await expect(api.submitVideo({
        audioAssets: [],
        imageAssets: [imageAsset],
        model: "Seedance_1.0_fast",
        prompt: "animate a paper bird",
        videoAssets: [],
        ...options,
      }, session, signal)).rejects.toThrow(expected)
    }
    expect(requestCount).toBe(0)
  })

  test("queries image thread artifacts and prefers the download scene URL", async () => {
    const api = apiFor(async (url, init) => {
      expect(url.pathname).toBe("/api/biz/v1/agent/get_thread")
      expect(JSON.parse(String(init?.body))).toEqual({
        run_id: task.runId,
        scopes: ["run_list.entry_list"],
        thread_id: task.threadId,
      })
      return Response.json({
        ret: "0",
        data: {
          thread: {
            thread_id: task.threadId,
            run_list: [{
              run_id: task.runId,
              thread_id: task.threadId,
              state: 3,
              entry_list: [artifactEntry("biz/x_data_image", {
                scene_urls: { download: "https://cdn.example.test/download.png" },
                url: "https://cdn.example.test/preview.png",
              })],
            }],
          },
        },
      })
    })

    expect(await api.query(task, "image", session, signal)).toEqual({
      ...task,
      imageUrls: ["https://cdn.example.test/download.png"],
      state: 3,
      videoUrls: [],
    })
  })

  test("queries video artifacts through the shared get-thread endpoint and accepts numeric string states", async () => {
    let legacyEndpointCalls = 0
    const api = apiFor(async (url, init) => {
      if (url.pathname === "/api/biz/v1/agent/query_generate_video_result") {
        legacyEndpointCalls += 1
      }
      expect(url.pathname).toBe("/api/biz/v1/agent/get_thread")
      expect(JSON.parse(String(init?.body))).toEqual({
        run_id: task.runId,
        scopes: ["run_list.entry_list"],
        thread_id: task.threadId,
      })
      return threadResponse({
        entry_list: [
          artifactEntry("biz/x_data_image", { url: "https://cdn.example.test/preview.png" }),
          artifactEntry("biz/x_data_video", { url: "https://cdn.example.test/result.mp4" }),
        ],
        run_id: task.runId,
        state: "3",
        thread_id: task.threadId,
      })
    })

    expect(await api.query(task, "video", session, signal)).toEqual({
      ...task,
      imageUrls: ["https://cdn.example.test/preview.png"],
      state: 3,
      videoUrls: ["https://cdn.example.test/result.mp4"],
    })
    expect(legacyEndpointCalls).toBe(0)
  })

  test("strictly parses running and failed video result states", async () => {
    const responses: Array<Record<string, unknown>> = [
      {
        entry_list: [],
        run_id: task.runId,
        state: 2,
        thread_id: task.threadId,
      },
      {
        entry_list: [],
        fail_reason: { message: "video generation failed" },
        run_id: task.runId,
        state: "4",
        thread_id: task.threadId,
      },
    ]
    const api = apiFor(() => threadResponse(responses.shift()!))

    expect(await api.query(task, "video", session, signal)).toEqual({
      ...task,
      imageUrls: [],
      state: 2,
      videoUrls: [],
    })
    expect(await api.query(task, "video", session, signal)).toEqual({
      ...task,
      error: "video generation failed",
      imageUrls: [],
      state: 4,
      videoUrls: [],
    })
  })

  test("classifies only the exact live unsupported raw-image terminal failure", async () => {
    const responses: Array<{ output: "image" | "video"; run: Record<string, unknown> }> = [
      {
        output: "image",
        run: {
          entry_list: [],
          fail_reason: { message: "unsupported image_model_name: nova2" },
          run_id: task.runId,
          state: 4,
          thread_id: task.threadId,
        },
      },
      {
        output: "image",
        run: {
          entry_list: [],
          fail_reason: { message: "unsupported image_model_name: private-vendor-value" },
          run_id: task.runId,
          state: 4,
          thread_id: task.threadId,
        },
      },
      {
        output: "video",
        run: {
          entry_list: [],
          fail_reason: { message: "unsupported image_model_name: nova2" },
          run_id: task.runId,
          state: 4,
          thread_id: task.threadId,
        },
      },
    ]
    const api = apiFor(() => threadResponse(responses[0]!.run))

    const exact = await api.query(task, responses[0]!.output, session, signal)
    expect(exact).toMatchObject({
      state: 4,
      terminalDiagnosticCode: "unsupported-image-model",
    })

    responses.shift()
    const arbitrary = await api.query(task, responses[0]!.output, session, signal)
    expect(arbitrary).not.toHaveProperty("terminalDiagnosticCode")

    responses.shift()
    const wrongCapability = await api.query(task, responses[0]!.output, session, signal)
    expect(wrongCapability).not.toHaveProperty("terminalDiagnosticCode")
  })

  test("allows unfinished media only while a run is not complete", async () => {
    const unfinished = artifactEntry("biz/x_data_video", {})
    const pending = apiFor(() => threadResponse({
      entry_list: [unfinished],
      run_id: task.runId,
      state: 2,
      thread_id: task.threadId,
    }))

    expect(await pending.query(task, "video", session, signal)).toEqual({
      ...task,
      imageUrls: [],
      state: 2,
      videoUrls: [],
    })

    const completed = apiFor(() => threadResponse({
      entry_list: [unfinished],
      run_id: task.runId,
      state: 3,
      thread_id: task.threadId,
    }))
    await expect(completed.query(task, "video", session, signal))
      .rejects.toThrow("video artifact URL is invalid")

    const completedWithoutMedia = apiFor(() => threadResponse({
      entry_list: [],
      run_id: task.runId,
      state: 3,
      thread_id: task.threadId,
    }))
    expect(await completedWithoutMedia.query(task, "video", session, signal)).toMatchObject({
      error: "XiaoYunque returned no video artifact",
      state: 3,
      videoUrls: [],
    })

    const unsafePending = apiFor(() => threadResponse({
      entry_list: [artifactEntry("biz/x_data_video", { url: "file:///private/result.mp4" })],
      run_id: task.runId,
      state: 2,
      thread_id: task.threadId,
    }))
    await expect(unsafePending.query(task, "video", session, signal))
      .rejects.toThrow("video artifact URL is invalid")

    const structurallyInvalidPending = apiFor(() => threadResponse({
      entry_list: [{ artifact: { content: "not-an-array" }, type: 2 }],
      run_id: task.runId,
      state: 2,
      thread_id: task.threadId,
    }))
    await expect(structurallyInvalidPending.query(task, "video", session, signal))
      .rejects.toThrow("generation content is invalid")

    const malformedMediaPending = apiFor(() => threadResponse({
      entry_list: [{
        artifact: {
          content: [{
            data: JSON.stringify({ video: "not-an-object" }),
            sub_type: "biz/x_data_video",
          }],
        },
        type: 2,
      }],
      run_id: task.runId,
      state: 2,
      thread_id: task.threadId,
    }))
    await expect(malformedMediaPending.query(task, "video", session, signal))
      .rejects.toThrow("generation artifact is invalid")
  })

  test("bounds one generation status request and aborts the stalled HTTP exchange", async () => {
    let requestAborted = false
    const stalledFetch = (async (_input: string | URL | Request, init?: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => {
        const requestSignal = init?.signal
        requestSignal?.addEventListener("abort", () => {
          requestAborted = true
          reject(requestSignal.reason ?? new DOMException("Request aborted", "AbortError"))
        }, { once: true })
      })
    }) as typeof fetch
    const api = new XiaoYunqueApi(
      "https://xyq.jianying.com",
      stalledFetch,
      { queryRequestTimeoutMs: 5 },
    )

    const failure = await api.query(task, "video", session, signal).catch((error: unknown) => error)

    expect(failure).toBeInstanceOf(XiaoYunqueQueryTimeoutError)
    expect((failure as Error).message).toBe("XiaoYunque generation status request timed out")
    expect(requestAborted).toBeTrue()
  })

  test("classifies HTTP 401 and ret 1015 without exposing response content", async () => {
    const httpUnauthorized = apiFor(() => new Response("private response body", { status: 401 }))
    await expect(httpUnauthorized.query(task, "video", session, signal))
      .rejects.toBeInstanceOf(XiaoYunqueAuthenticationError)

    const retUnauthorized = apiFor(() => Response.json({
      ret: 1015,
      errmsg: "private server diagnostic",
    }))
    try {
      await retUnauthorized.query(task, "video", session, signal)
      throw new Error("expected authentication error")
    } catch (error) {
      expect(error).toBeInstanceOf(XiaoYunqueAuthenticationError)
      expect(String(error)).not.toContain("private server diagnostic")
    }
  })

  test("rejects missing Cookie state before any network request", async () => {
    let calls = 0
    const api = apiFor(() => {
      calls += 1
      return Response.json({ ret: 0 })
    })
    await expect(api.query(task, "video", { ...session, cookies: [] }, signal))
      .rejects.toBeInstanceOf(XiaoYunqueAuthenticationError)
    expect(calls).toBe(0)
  })

  test("rejects mismatched tasks, invalid artifacts, and oversized JSON without response leakage", async () => {
    const mismatch = apiFor(() => threadResponse({
      entry_list: [],
      run_id: task.runId,
      state: 2,
      thread_id: "different-thread",
    }, "different-thread"))
    await expect(mismatch.query(task, "video", session, signal)).rejects.toThrow("does not match")

    const malformedArtifact = apiFor(() => threadResponse({
      entry_list: [artifactEntry("biz/x_data_video", { url: "file:///private/result.mp4" })],
      run_id: task.runId,
      state: 3,
      thread_id: task.threadId,
    }))
    await expect(malformedArtifact.query(task, "video", session, signal)).rejects.toThrow("artifact URL is invalid")

    const oversized = apiFor(() => new Response("{}", {
      headers: { "Content-Length": String(2 * 1024 * 1024 + 1) },
    }))
    await expect(oversized.query(task, "video", session, signal)).rejects.toThrow("invalid response")
  })

  test("rejects malformed video states and non-success envelopes without diagnostic leakage", async () => {
    const malformedState = apiFor(() => threadResponse({
      entry_list: [],
      run_id: task.runId,
      state: "03",
      thread_id: task.threadId,
    }))
    await expect(malformedState.query(task, "video", session, signal))
      .rejects.toThrow("generation state is invalid")

    const rejected = apiFor(() => Response.json({
      ret: 4001,
      errmsg: "private upstream diagnostic",
    }))
    try {
      await rejected.query(task, "video", session, signal)
      throw new Error("expected rejected response")
    } catch (error) {
      expect(error).toBeInstanceOf(XiaoYunqueRequestRejectedError)
      expect((error as XiaoYunqueRequestRejectedError).diagnosticCode)
        .toBe("upstream-envelope-rejected")
      expect(String(error)).toContain("was rejected")
      expect(String(error)).not.toContain("private upstream diagnostic")
    }

    const httpRejected = apiFor(() => Response.json({
      ret: 0,
      data: { private: "response body" },
    }, { status: 409 }))
    const httpFailure = await httpRejected.query(task, "video", session, signal)
      .catch((error: unknown) => error)
    expect(httpFailure).toBeInstanceOf(XiaoYunqueRequestRejectedError)
    expect((httpFailure as XiaoYunqueRequestRejectedError).diagnosticCode)
      .toBe("upstream-http-rejected")
    expect(String(httpFailure)).not.toContain("response body")
  })

  test("keeps a real loopback fake API available without weakening production origins", async () => {
    let receivedCookie = ""
    let server: ReturnType<typeof Bun.serve>
    server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request): Response {
        receivedCookie = request.headers.get("cookie") ?? ""
        return threadResponse({
          entry_list: [artifactEntry("biz/x_data_video", {
            url: `http://127.0.0.1:${server.port}/result.mp4`,
          })],
          run_id: task.runId,
          state: 3,
          thread_id: task.threadId,
        })
      },
    })
    servers.push(server)
    const api = new XiaoYunqueApi(`http://127.0.0.1:${server.port}`)
    expect(await api.query(task, "video", session, signal)).toMatchObject({ state: 3 })
    expect(receivedCookie).toBe("sessionid_pippitcn_web=private-cookie-value")
    expect(() => new XiaoYunqueApi("https://attacker.example.test"))
      .toThrow("origin is invalid")
  })
})
