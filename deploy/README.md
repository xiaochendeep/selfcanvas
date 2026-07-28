# Windows WSL / Ubuntu 部署

目标机默认使用 `deploy@192.168.15.185:2222`，应用目录为
`/home/deploy/selfcanvas`。脚本保留远端 `.env`、`.runtime` 和 `output`，只替换程序文件。

```bash
./deploy/push-windows-wsl.sh
```

若目标机使用指定 SSH 私钥或标准 22 端口：

```bash
SELF_CANVAS_DEPLOY_PORT=22 \
SELF_CANVAS_DEPLOY_IDENTITY="$HOME/.ssh/id_ed25519" \
  ./deploy/push-windows-wsl.sh
```

如果远端账号的 sudo 需要密码，可启用交互式 sudo（脚本不会保存密码）：

```bash
SELF_CANVAS_DEPLOY_PORT=22 \
SELF_CANVAS_REMOTE_INTERACTIVE_SUDO=1 \
  ./deploy/push-windows-wsl.sh
```

若当前 Mac 需要通过 Clash SOCKS 访问 15 网段：

```bash
SELF_CANVAS_SSH_PROXY_COMMAND='nc -x 127.0.0.1:7897 -X 5 %h %p' \
  ./deploy/push-windows-wsl.sh
```

部署脚本会在本机先执行构建与完整测试；远端执行 `npm ci`、构建、生成独立的 API/MCP
Bearer Token、安装 Supervisor 配置，并验证 8787/8790 健康状态。Token 不打印到终端。脚本会把
`SELF_CANVAS_PUBLIC_BASE_URL` 默认设置成目标机局域网 8787 地址，确保 Codex 收到的下载链接
不会错误指向容器名或 localhost；若使用域名/反向代理可在执行脚本前显式覆盖该变量。

远端必须预先具备 Node.js 20.18.1+、Python 3、Redis、Supervisor、FFmpeg/FFprobe，以及
`deploy` 用户的 sudo Supervisor 配置安装/重启权限。默认使用免密码 sudo；也可开启上述交互式 sudo。AnyCap CLI 缺失时下载和本地视频合并仍可用，
但 AnyCap 生成、视频理解和创意改编会提示不可用。

Codex HTTP MCP 地址为：

```text
http://192.168.15.185:8790/mcp
```

把远端 `.env` 中的 `SELF_CANVAS_MCP_TOKEN` 安全地配置到运行 Codex 的电脑环境变量，
再参考 `docs/codex/config.toml.example`。不要把 Token 写入仓库或聊天记录。
