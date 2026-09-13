# 阿里云内网部署

部署目录：`/opt/selfcanvas-private`。这是现有阿里云 WireGuard / Tailscale 网关上的独立环境，不替换本机或 Windows 的项目数据。

## 访问

先连接已有的 WireGuard 或 Tailscale。没有公网网站入口，也未开放云安全组端口。

| 服务 | WireGuard | Tailscale |
| --- | --- | --- |
| SelfCanvas | `http://10.66.66.1:5190/` | `http://100.78.18.60:5190/` |
| Sub2API 后台及网关 | `http://10.66.66.1:8080/` | `http://100.78.18.60:8080/` |
| SelfCanvas MCP | `http://10.66.66.1:8790/mcp` | 首次部署不提供此入口 |

Sub2API 管理员：`admin@selfcanvas.local`。随机密码及 MCP Token 仅保存在服务器 `ACCESS.txt` / `.env`（0600），不要提交到 Git。首次部署的凭证副本存入本机 Downloads 的 `SelfCanvas-阿里云-内网访问.txt`。

当前 HTTP 只在加密 VPN / SSH 隧道内传输；并未签发浏览器 HTTPS 证书。内部用户共用当前 SelfCanvas 项目，不是多人租户隔离系统。Sub2API 后台另有管理员登录。

本机验收临时 SSH 转发：`127.0.0.1:15190` → 云画布；`127.0.0.1:18080` → 云 Sub2API。隧道关闭后需要连接 VPN 或重新建立转发；本机原来的 5190 服务不受影响。

## 初始边界

- 新环境默认画布；未迁移本机素材、旧任务队列、供应商密钥或 AnyCap 登录态。需要迁移时先单独备份并确认。
- 已安装 Sub2API v0.2.3，并固定官方镜像 digest；PostgreSQL 18、Redis 8、Nginx 也固定此次验证的 digest。
- 未配置上游模型账号。SelfCanvas 普通网关地址预置为 `http://127.0.0.1:8080`，创作助手地址为 `http://127.0.0.1:8080/v1`；API Key 和模型留空，不会假称能力可用。
- 两类生成 worker 放在 `workers` profile，默认不启动。不要在审查待处理队列、填好供应商配置之前开启，避免意外付费。
- MCP 初始仅 `canvas:read,generation:read,artifacts:read,artifacts:download`。写画布和生成权限未开放。下载结果使用 WireGuard 地址，因此没有伪装成完全等价的 Tailscale MCP 入口。
- 内网 HTTP 的 requestId 兼容修复只影响幂等标识，未改变 Token / CSRF 随机数安全逻辑。

## 网络与资源隔离

- 所有容器使用 Linux host network，但应用、PostgreSQL、Redis、MCP **显式只监听 localhost**；Nginx 仅监听表中 VPN IP。
- Docker 的 bridge、iptables/ip6tables、IP forwarding 管理和 masquerade 均关闭。此 daemon 设置仅适用于这台初次安装 Docker 的网关，不要覆盖其他已使用 Docker 网桥的主机配置。
- 独立 nftables 表 `inet selfcanvas_private` 拒绝从非 lo/wg0/wg-home/tailscale0 接口访问本项目端口，没有 flush 或替换现有路由防火墙。
- Nginx 限定私网来源和 Host，覆盖代理来源头，支持 SSE/WebSocket；Sub2API 只信任 loopback 反代，默认拒绝私网和 HTTP 上游目标。未来如接内网模型网关，需要按明确地址重新审核 allowlist。
- `selfcanvas.slice` 上限 900 MiB、150% CPU，另有 2 GiB 主机 swap（服务 slice 最多使用 1 GiB swap）。这是轻量空载部署，不保证多用户长视频渲染吞吐；视频 worker 暂停。
- 开机服务等待两 VPN 地址就绪。地址缺失会拒绝启动，不会回退为公网监听；容器设置 `unless-stopped`。

## 运维

```bash
cd /opt/selfcanvas-private
docker compose ps
python3 verify-private.py
systemctl status selfcanvas-private.service selfcanvas-private-access.service
```

更新先备份数据与凭证；仅更新 `app`、镜像和非敏感部署配置，不覆盖 `data/`、`.env` 或 `ACCESS.txt`。`initialize-secrets.py` 只用于第一次初始化，存在凭证会拒绝重建。更改环境变量后用 `docker compose up -d` 重建相关容器；单纯 `restart` 不应用新环境变量。后台现有管理员密码不能靠修改 `ADMIN_PASSWORD` 重置。

本机生产构建后，按 Dockerfile 的白名单发送运行文件（不发送 `.env`、`.runtime`、`output`、iOS 或整个工作区），远端执行：

```bash
cd /opt/selfcanvas-private/app
docker build --network host --platform linux/amd64 \
  -f deploy/aliyun/Dockerfile.selfcanvas -t selfcanvas:2026-09-08-private .
```

手动备份应同时包含 PostgreSQL 逻辑备份、两 Redis AOF、Sub2API data、画布 runtime/output/AnyCap 登录态和 `.env`。一致性备份期间暂停本项目服务（保留 PostgreSQL 做 `pg_dump`），不要停止网关原有 WireGuard/Tailscale/Xray。首次部署前的规则快照在 `backups/before-install/`；它只用于比对，禁止直接用旧 nft 快照覆盖当前整个规则集。

停止本项目：`systemctl stop selfcanvas-private`。该操作保留数据、内网入口限制和原有 VPN 服务；删除数据、卸载 Docker、移除 swap 需另行确认。

## 验收记录（2026-09-08）

- 本地生产 build 成功；30 个相关 TypeScript 测试通过。
- 云端实际构建 amd64 镜像成功；AnyCap 压缩包 SHA-256 校验成功，FFmpeg/ffprobe 已安装。
- 8/8 服务验收：JS/CSS、健康、cookie/CSRF 读画布、恶意 Origin 拒绝、Sub2API 初始化及真实管理员登录、MCP 初始化/列表/读画布/生成权限拒绝。
- 浏览器通过 SSH 隧道显示云端默认画布和“已同步”；本机旧画布未覆盖。
- 未带 MCP Token 返回 401；跨站 Origin 返回 403；未知 Host 返回 421。
- 从 Mac 的物理网络请求公网 IP 的 5190/8080/8790 全部连接超时；服务监听表无这些端口的公网 / IPv6 wildcard 监听。
- 原有策略路由与部署前一致；国内、国外、家庭网段三条路由检查正确，WG/Tailscale/Xray 都保持运行。
- 未做付费模型生成、压测、真实跨设备 VPN 浏览器验收或整机重启。后续配好上游后需要单独验收。

依据：[Sub2API 官方 v0.2.3](https://github.com/Wei-Shaw/sub2api/releases/tag/v0.2.3)、[同版本 Compose](https://github.com/Wei-Shaw/sub2api/blob/v0.2.3/deploy/docker-compose.local.yml)、[Docker Debian 安装](https://docs.docker.com/engine/install/debian/)、[Docker 网络防火墙行为](https://docs.docker.com/engine/network/packet-filtering-firewalls/)。
