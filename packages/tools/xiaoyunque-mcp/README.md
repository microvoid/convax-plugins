# 小云雀 Generation MCP sidecar

`convax-xiaoyunque-mcp` 是 `xiaoyunque-generation` Tool Plugin 的独立执行端。
Convax 上层只看到插件声明、固定 service actions 和
`convax.generation-call/1`；小云雀 Cookie、接口路径和任务轮询始终留在 sidecar
边界内。

## 构建与发布

```sh
bun install
bun typecheck
bun test
bun run build
bun run build:release:darwin-arm64
```

正式发布产物为 `dist/darwin-arm64/convax-xiaoyunque-mcp`。它是带有精确
`#!/usr/bin/env convax-bun` 标头的小型 Bun 程序，通过兼容版本 Convax 已随应用
发布的共享 Bun runtime 运行，不再为这个插件重复打包一份 Bun。它作为独立的
`convax-companion-*` Release asset 发布，由 Registry 固定 URL、字节数和
SHA-256；Convax 安装插件时把它放入宿主管理目录。可执行文件不进入静态 Plugin
ZIP，也不要求用户配置 `PATH`。

开发态可手工安装：

```sh
install -m 0755 dist/convax-xiaoyunque-mcp ~/.local/bin/convax-xiaoyunque-mcp
```

## 宿主管理的网页授权

在 Convax **服务 → 小云雀生成** 中点击“授权”或“重新授权”时，sidecar 只返回
严格的 `convax.plugin-service-browser-authorization/1` 请求：

- 登录页固定为 `https://xyq.jianying.com/login?redirect_url=%2F`，官网登录完成后
  回到同源首页作为授权确认目标；
- Cookie origin 固定为 `https://xyq.jianying.com`；
- 只允许当前第一方 Web 端的 `sessionid_pippitcn_web`、
  `sessionid_ss_pippitcn_web`；
- authorization id 随机、一次性；宿主浏览器授权窗口最长保留 30 分钟。
  窗口截止后 sidecar 只为宿主已捕获的 completion 保留 30 秒内部交接宽限；
  取消、退出登录或 sidecar 关闭仍会立即使请求失效。

Convax main 在独立、临时、非持久化的浏览器 session 中打开官网。用户完成官网
登录并明确确认后，宿主只读取上述 origin 和名称白名单中的 Cookie，再通过固定
`service.authorization.complete` 回送
`convax.plugin-service-browser-authorization-completion/1`。该 completion 由宿主绑定
到同一个插件、清单、可执行快照和 MCP client；renderer 不能选择方法或构造参数。

sidecar 不会读取 Chrome/Safari 等现有浏览器资料，不启动 loopback callback，不访问
Passport/grant/QueryAk/GenerateAk，不创建或缓存 AK/SK，也不执行小云雀 CLI。

完成后的 Cookie session 是唯一的 configured 状态，原子写入插件私有
`web-session.json`：目录 `0700`、文件 `0600`。重新授权只有在完整新会话成功落盘后
才替换旧会话；无效/stale completion、取消、超时或写入失败都会保留旧会话。sidecar
退出只丢弃内存中的 pending authorization，明确“退出登录”才清除持久会话。
旧版已落盘的无后缀 `sessionid` / `sessionid_ss` 只作兼容读取，新的网页授权
请求和 completion 不会扩大到这些旧名称。

Cookie 从不进入 stdout、日志或 service status。`0600` 只能隔离其他系统用户，不能
抵御同一系统账号下的恶意进程；这是本地 sidecar 的系统信任边界。

## 能力

- 图像：只暴露 Seedream 5.0 与 Seedream 5.0 Pro，默认使用 Seedream 5.0；两者
  均支持 prompt 与参考图。
- 视频：只暴露 Seedance 2.0、Seedance 2.0 Mini Lite（非 VIP 通道）以及
  Seedance 2.0 Vision、Seedance 2.0 Mini（VIP 通道），默认使用 Seedance 2.0
  Mini Lite。四个模型均支持参考图、参考视频、音频、首帧与首尾帧；请求体不向 Mini
  系列发送网页端省略的分辨率字段。
- 服务：`service.status` 使用同一 Cookie session 读取固定的账号、积分和最近最多
  20 条已结算消费记录；缺失或失败的数据返回 `unavailable`，不会猜测。

生成物只写入 Convax 提供的临时 `output_directory`，验证媒体签名和大小后再由
Convax managed asset 流程纳入 `.convax/assets`。sidecar 不读取 `.convax` 私有状态。
生成状态处于 pending/running 时不会因为总耗时过长而失败；每次状态查询有独立的
30 秒网络超时并可重试，任务会持续等待到成功、服务端明确失败或用户取消。已经提交的
operation id 会持久化，查询超时或进程重启不会重复提交计费任务。

## 验证

常规测试只使用本机 fake API，不消费积分：

```sh
bun typecheck
bun test
bun run build
```

真实生图 smoke 需要用户在宿主管理的隔离登录窗口中完成授权，并会消费一次生图额度。
真实生视频 smoke 默认使用 Seedance 2.0 Mini Lite、5 秒、无参考素材，并会消费视频积分；
只有显式设置视频专用开关才会运行：

```sh
bun run build
CONVAX_LIVE_XIAOYUNQUE_VIDEO=1 bun run smoke:live:video -- "一只小云雀轻轻扇动翅膀"
```

脚本仅输出执行阶段、可用于恢复同一已提交任务的 `operation_id` 和最终 artifact
元数据；失败时只转发 sidecar 固定白名单中的安全错误类别，不回显其他 stderr、
MCP 内容、Cookie 或上游原始错误。
生视频只做 fake API 契约测试，默认不执行真实计费请求。
