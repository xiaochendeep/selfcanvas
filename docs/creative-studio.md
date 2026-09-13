# SelfCanvas 创作助手与模型网关

## 使用流程

侧边栏「创作助手」提供三个入口：

1. 一键剧本：创意/原文 → 有人物、动作、对白、节奏的候选剧本。
2. 图片分镜：剧本 → 可编辑镜头卡、独立图片提示词和对应视频提示词。确认「加入画布」后，生成一个分镜文档节点和每镜一个待生成图片节点；明确确认批量生成才调用图片模型。
3. 视频爆点分析：选择当前画布中已落盘的视频 → 带时间码的可见/可听证据、吸引力推断、手法和改编建议。不是平台热度检测，不承诺真实播放表现。

生成剧本/分镜草稿使用文本模型；分析使用视频理解模型；图片出图继续复用现有 AnyCap 媒体队列。草稿生成不修改画布，不自动串联付费生成。用户可在加入画布前编辑提示词。

`image` 和 `video` 是提示词/导演方法，不是媒体模型，也不借用 Codex 登录凭据。它们已适配为 `prompts/creative/*.md`，由服务端组装为模型系统规则；不依赖服务器安装本机的 `/Users/.../.codex/skills`。

## 后续网关配置

在服务器环境配置下列变量（样例值是占位符，不能直接作为已验证的模型使用）：

```dotenv
SELF_CANVAS_CREATIVE_BASE_URL=http://192.168.15.185:4000
SELF_CANVAS_CREATIVE_API_KEY=<你的网关密钥>
SELF_CANVAS_CREATIVE_TEXT_MODEL=<网关里的文本模型ID>
SELF_CANVAS_CREATIVE_VISION_BASE_URL=http://192.168.15.185:4000
SELF_CANVAS_CREATIVE_VISION_API_KEY=<视频模型网关密钥>
SELF_CANVAS_CREATIVE_VISION_MODEL=<网关里的Gemini模型ID>
SELF_CANVAS_CREATIVE_VIDEO_PROTOCOL=gemini
SELF_CANVAS_CREATIVE_TIMEOUT_SECONDS=90
```

不要把密钥放在 `VITE_*`、前端本地存储、画布节点或提示词中。Docker Compose 已将这些变量传给 API 服务；本机直接启动时需由进程环境提供。未配置时三个入口明确显示未配置，绝不退回模拟成功。

- 文本协议：`POST /v1/chat/completions`，非流式 JSON 对象响应。
- Gemini 协议：`POST /v1beta/models/{model}:generateContent`，`systemInstruction` + `contents.parts`，视频用 `inlineData`。当前原生接口字段参考 [Gemini generateContent](https://ai.google.dev/api/generate-content)。
- 若网关只支持 OpenAI 兼容视频扩展，可设置 `VIDEO_PROTOCOL=openai`（完整变量名见上），但网关必须明确支持 `video_url` 携带 base64 data URL；这不是所有 OpenAI 兼容服务都支持的标准能力。
- 图片模型仍走现有 AnyCap 目录和 worker；新的文本/视频理解网关并不自动代理图片出图。后续换图片网关时另加媒体适配器，不会只改名称后假装兼容。
- 可用 `SELF_CANVAS_CREATIVE_TEXT_MODELS` / `SELF_CANVAS_CREATIVE_VISION_MODELS` 配置逗号分隔的额外允许模型 ID；默认模型仍由单数变量指定。
- 文本与视频网关仅在同一 origin 时允许继承密钥。不同主机/端口须显式配置视频密钥；确实无需认证的独立内网网关需设置 `SELF_CANVAS_CREATIVE_VISION_ALLOW_ANONYMOUS=true`，不会把文本密钥误发到另一服务。
- 已配置不等于已完成联调。能力接口不会为测试连接偷偷调用收费模型。

视频输入首版限 14 MiB，必须是已落盘且通过 ffprobe 检查的 MP4/MOV/WebM。超过限制需导入压缩副本，不会静默只抽帧却声称已完整分析声音。大视频后续可增加 Gemini Files API 或网关受控文件上传；官方说明见 [视频理解输入方式](https://ai.google.dev/gemini-api/docs/video-understanding)。

## API / Codex

- `GET /api/v2/creative/capabilities`：安全状态、模型、能力限制，不返回地址和密钥。
- `POST /api/v2/creative/runs`：`kind` 为 `script` / `storyboard` / `video-analysis`，需 `canvasId`、幂等 `requestId`、`confirmed:true`，分析需当前画布 `sourceNodeId`。
- Codex MCP：`canvas_get_creative_capabilities` 和 `canvas_create_creative_draft`。后者要求 `generation:run` 权限与明确调用确认；读取不自动执行收费生成。
- 请求结果是草稿，不是操作列表。Codex 应展示草稿，再按用户授权调用现有 CAS 画布接口；不能直接执行模型回复中出现的命令或网址。

服务器持久记录 requestId 及请求指纹。重复相同请求返回已有结果，重复 ID 但不同内容返回冲突。请求超时/中断时不能自动换 ID 再提交，避免重复扣费；需先用原 ID 查询已有结果，仍不确定时人工确认。

画布导入仅添加新节点，按 runId 去重。已有同步冲突会阻止导入，不自动覆盖服务器项目；不能把已有节点结果当作新任务覆盖。原来的项目保存仍由仓库 CAS 机制控制。

## 技能来源与改编

作者：Serge Shima。来源：[smixs/visual-skills](https://github.com/smixs/visual-skills)。许可：[CC BY 4.0](https://creativecommons.org/licenses/by/4.0/)。

使用 `image` / `video` 的戏剧结构、镜头功能、三种具体细节、静帧与运动分工、五槽/GPT 与自然段/Nano Banana 提示方法、连续性和审阅要求。SelfCanvas 改编为中文规则、结构化输出协议、输入/证据边界；未复制技能里的示例人物/剧情，未将其他平台的参考数量、时长和价格硬编码成当前 AnyCap 能力。

## 当前验收边界

网关尚由用户后续搭建。本轮使用隔离测试与 mock 网关验证协议、身份检查、幂等、输出校验、草稿编辑和画布导入逻辑；不等于已调用真实 Gemini 或已生成实际图片。未部署 Windows，未自动运行旧队列。未来真实联调时应分别验收剧本文本质量、图片一致性、视频画面与声音证据。

2026-09-08 本机验证：

- Python API/创作回归 43 项、TypeScript 纯逻辑 26 项、MCP/媒体/剪辑 51 项，共 120 项通过；生产构建通过。
- 本机 `/api/health` 与通过浏览器会话鉴权的 `/api/v2/creative/capabilities` 返回 HTTP 200；三个能力均如实标为 `not-configured`。
- Mac 锁屏，未完成浏览器视觉、鼠标选字、剪贴板与弹窗交互验收；不可据自动化逻辑测试声称这些交互已经实测通过。
- 构建仍有现存的大包警告，以及浏览器会话模块同时被静态/动态引用的非阻断警告。
