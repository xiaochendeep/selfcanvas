# SelfCanvas × Codex

本目录提供 SelfCanvas MCP 的 Codex App、Codex CLI 和 IDE 配置。MCP 只调用
`SELF_CANVAS_BASE_URL` 下的 `/api/v2/*` 画布接口，不读取项目文件，也不会向 Codex 返回
API Key、供应商地址、本地绝对路径或内联大文件。

## 推荐：Streamable HTTP

适合 Codex 与 SelfCanvas 不在同一台机器的情况。先确保 SelfCanvas API 已运行，再启动 MCP：

```bash
export SELF_CANVAS_BASE_URL=http://127.0.0.1:8787
export SELF_CANVAS_PUBLIC_BASE_URL=http://192.168.15.185:8787
export SELF_CANVAS_API_TOKEN="$(openssl rand -hex 32)"
export SELF_CANVAS_MCP_TOKEN="$(openssl rand -hex 32)"
export SELF_CANVAS_MCP_HOST=0.0.0.0
export SELF_CANVAS_MCP_PORT=8790
npm run mcp:http
```

在运行 Codex 的电脑上设置同一个 `SELF_CANVAS_MCP_TOKEN`，然后把
[`config.toml.example`](./config.toml.example) 的 HTTP 部分合并到 `~/.codex/config.toml`。
Windows 目标机地址示例为 `http://192.168.15.185:8790/mcp`。仅在可信局域网或 VPN 中开放
8790 端口，不要把 MCP 直接暴露到公网。

HTTP `/mcp` 强制使用 Bearer Token。`GET /health` 只返回服务存活状态，不返回路径、配置或
密钥。MCP 进程必须设置 `SELF_CANVAS_API_TOKEN` 才能访问 v2 REST API；它与 Codex 使用的
MCP Token 必须使用不同的随机值。

`SELF_CANVAS_BASE_URL` 是 MCP 服务访问 API 的内部地址；`SELF_CANVAS_PUBLIC_BASE_URL` 是返回
给 Codex 的下载/预览地址。Docker 内前者可以是 `http://selfcanvas:8787`，但后者必须填写
Codex 所在电脑实际可访问的 Windows 局域网地址，不能填写容器名或目标机 localhost。

## 同机：stdio

同一台机器上的 Codex 可以直接拉起进程，无需开放 8790：

```toml
[mcp_servers.selfcanvas]
command = "node"
args = ["/absolute/path/to/canvaspro-ui-studio/mcp/stdio.mjs"]
cwd = "/absolute/path/to/canvaspro-ui-studio"
default_tools_approval_mode = "writes"
tool_timeout_sec = 90

[mcp_servers.selfcanvas.env]
SELF_CANVAS_BASE_URL = "http://127.0.0.1:8787"
SELF_CANVAS_PUBLIC_BASE_URL = "http://127.0.0.1:8787"
SELF_CANVAS_MCP_SCOPES = "canvas:read,canvas:write,generation:read,generation:run,artifacts:read,artifacts:download"
```

stdio 子进程还必须从启动 Codex 的环境继承 `SELF_CANVAS_API_TOKEN`，不要把真实 Token 直接写进
可提交的配置文件。

stdio 模式的 stdout 专用于 MCP 协议，日志只写 stderr。

## 权限与确认

`SELF_CANVAS_MCP_SCOPES` 是逗号或空格分隔的权限列表；未设置时默认启用全部权限：

- `canvas:read`：列出、读取画布和搜索节点。
- `canvas:write`：非删除型画布操作。
- `generation:read`：读取后台任务。
- `generation:run`：运行节点和创建视频剪辑，可能调用付费 AI 服务。
- `artifacts:read`：列出已落盘产物。
- `artifacts:download`：准备单文件下载或 ZIP 打包。

配置模板使用 `default_tools_approval_mode = "writes"`：只读工具可自动运行，写入、下载准备和
付费生成会要求用户确认。MCP 工具本身不开放节点、画布或文件删除能力。

## 并发与重试约定

- 写操作必须先读取画布的最新 `revision`，再作为 `baseRevision` 提交。
- 用户说“找到/定位某个素材”时，先用 `canvas_search_nodes` 搜索文件名、节点名或提示词，再以
  `focus_node` operation 写入；已打开的 SelfCanvas 浏览器会切换画布、选中节点并平滑居中。
- 每次用户意图生成一个稳定 `requestId`；网络重试必须复用原值，避免重复创建付费任务。
- 收到 `409 revision_conflict` 时重新读取画布，让用户确认后重做操作，禁止自动覆盖。
- 任务创建接口只返回任务信息；用 `canvas_get_job` 轮询，再用 `canvas_list_artifacts` 获取受控下载地址。
- 列表响应默认每页 20 条、最多 50 条；有 `nextCursor` 时继续分页，不要尝试解析游标。

## 可用工具

`canvas_list_canvases`、`canvas_get_canvas`、`canvas_search_nodes`、
`canvas_apply_operations`、`canvas_run_node`、`canvas_create_video_edit`、
`canvas_get_job`、`canvas_list_artifacts`、`canvas_prepare_download`。

运行契约测试：

```bash
npm run test:mcp
```

Codex MCP 配置字段以 [OpenAI 官方 MCP 文档](https://developers.openai.com/codex/mcp/) 为准。
