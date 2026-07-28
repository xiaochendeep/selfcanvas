#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TARGET_HOST="${SELF_CANVAS_DEPLOY_HOST:-192.168.15.185}"
TARGET_PORT="${SELF_CANVAS_DEPLOY_PORT:-2222}"
TARGET_USER="${SELF_CANVAS_DEPLOY_USER:-deploy}"
REMOTE_DIR="${SELF_CANVAS_REMOTE_DIR:-/home/deploy/selfcanvas}"
SSH_PROXY_COMMAND="${SELF_CANVAS_SSH_PROXY_COMMAND:-}"
SSH_IDENTITY="${SELF_CANVAS_DEPLOY_IDENTITY:-}"
PUBLIC_BASE_URL="${SELF_CANVAS_PUBLIC_BASE_URL:-http://$TARGET_HOST:8787}"
REMOTE_INTERACTIVE_SUDO="${SELF_CANVAS_REMOTE_INTERACTIVE_SUDO:-0}"

if [[ ! "$PUBLIC_BASE_URL" =~ ^https?://[A-Za-z0-9.-]+(:[0-9]+)?/?$ ]]; then
  echo "SELF_CANVAS_PUBLIC_BASE_URL 必须是无路径、无账号的 http/https 地址" >&2
  exit 1
fi

ssh_options=(-p "$TARGET_PORT" -o ConnectTimeout=15 -o ServerAliveInterval=10)
scp_options=(-O -P "$TARGET_PORT" -o ConnectTimeout=15)
if [[ -n "$SSH_PROXY_COMMAND" ]]; then
  ssh_options+=(-o "ProxyCommand=$SSH_PROXY_COMMAND")
  scp_options+=(-o "ProxyCommand=$SSH_PROXY_COMMAND")
fi
if [[ -n "$SSH_IDENTITY" ]]; then
  ssh_options+=(-i "$SSH_IDENTITY" -o IdentitiesOnly=yes)
  scp_options+=(-i "$SSH_IDENTITY" -o IdentitiesOnly=yes)
fi

archive="$(mktemp -t selfcanvas-release.XXXXXX.tar.gz)"
cleanup() { rm -f "$archive"; }
trap cleanup EXIT

cd "$ROOT_DIR"
if [[ "${SELF_CANVAS_SKIP_VERIFY:-0}" != "1" ]]; then
  npm run build
  npm run test:media
  npm run test:video-edit
  npm run test:mcp
  PYTHONPYCACHEPREFIX=/tmp/selfcanvas-pycache python3 -m unittest tests.test_server_api
fi

tar -czf "$archive" \
  --exclude='./.git' \
  --exclude='./.env' \
  --exclude='./.runtime' \
  --exclude='./output' \
  --exclude='./node_modules' \
  --exclude='./dist' \
  --exclude='./.DS_Store' \
  .

remote_archive="/tmp/selfcanvas-release-$$.tar.gz"
scp "${scp_options[@]}" "$archive" "$TARGET_USER@$TARGET_HOST:$remote_archive"

ssh "${ssh_options[@]}" "$TARGET_USER@$TARGET_HOST" \
  "REMOTE_DIR='$REMOTE_DIR' REMOTE_ARCHIVE='$remote_archive' PUBLIC_BASE_URL='$PUBLIC_BASE_URL' REMOTE_INTERACTIVE_SUDO='$REMOTE_INTERACTIVE_SUDO' bash -se" <<'REMOTE'
set -euo pipefail

mkdir -p "$REMOTE_DIR" "$REMOTE_DIR/.runtime" "$REMOTE_DIR/output"
chmod 700 "$REMOTE_DIR/.runtime"
tar -xzf "$REMOTE_ARCHIVE" -C "$REMOTE_DIR"
rm -f "$REMOTE_ARCHIVE"
cd "$REMOTE_DIR"
export PATH="$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin:$PATH"

for command_name in node npm python3 redis-server supervisorctl ffmpeg ffprobe; do
  if ! command -v "$command_name" >/dev/null 2>&1; then
    echo "缺少依赖：$command_name" >&2
    exit 1
  fi
done

node -e 'const [major, minor] = process.versions.node.split(".").map(Number); if (major < 20 || (major === 20 && minor < 18)) { console.error("需要 Node.js 20.18.1+；当前为 " + process.versions.node); process.exit(1); }'

npm ci
npm run build

touch .env
chmod 600 .env

random_token() {
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -hex 32
  else
    python3 -c 'import secrets; print(secrets.token_hex(32))'
  fi
}

upsert_env() {
  local key="$1" value="$2" tmp
  tmp="$(mktemp)"
  awk -v key="$key" -v value="$value" '
    BEGIN { replaced = 0 }
    index($0, key "=") == 1 {
      if (!replaced) print key "=" value
      replaced = 1
      next
    }
    { print }
    END { if (!replaced) print key "=" value }
  ' .env >"$tmp"
  mv "$tmp" .env
  chmod 600 .env
}

env_value() {
  awk -F= -v key="$1" '$1 == key { sub(/^[^=]*=/, ""); print; exit }' .env
}

upsert_env SELF_CANVAS_HOST 0.0.0.0
upsert_env SELF_CANVAS_PORT 8787
upsert_env SELF_CANVAS_STORAGE_ROOT "$REMOTE_DIR"
upsert_env OUTPUT_DIR "$REMOTE_DIR/output"
upsert_env REDIS_URL redis://127.0.0.1:6379/0
upsert_env SELF_CANVAS_MCP_HOST 0.0.0.0
upsert_env SELF_CANVAS_MCP_PORT 8790
upsert_env SELF_CANVAS_BASE_URL http://127.0.0.1:8787
upsert_env SELF_CANVAS_PUBLIC_BASE_URL "$PUBLIC_BASE_URL"

if [[ -z "$(env_value SELF_CANVAS_API_TOKEN)" ]]; then
  upsert_env SELF_CANVAS_API_TOKEN "$(random_token)"
fi
if [[ -z "$(env_value SELF_CANVAS_MCP_TOKEN)" ]]; then
  upsert_env SELF_CANVAS_MCP_TOKEN "$(random_token)"
fi
if [[ -z "$(env_value ANYCAP_AUDIO_MODEL)" ]]; then
  upsert_env ANYCAP_AUDIO_MODEL doubao-seed-audio-1-0
fi

if ! command -v anycap >/dev/null 2>&1; then
  echo "警告：AnyCap CLI 尚未安装；下载/合并可用，AnyCap 生成与视频理解暂不可用。" >&2
fi

if [[ "$REMOTE_INTERACTIVE_SUDO" != "1" ]]; then
  sudo -n env SELF_CANVAS_REMOTE_DIR="$REMOTE_DIR" bash deploy/activate-supervisor.sh
fi
REMOTE

if [[ "$REMOTE_INTERACTIVE_SUDO" == "1" ]]; then
  ssh -tt "${ssh_options[@]}" "$TARGET_USER@$TARGET_HOST" \
    "sudo -p '[selfcanvas-sudo]password:' env SELF_CANVAS_REMOTE_DIR='$REMOTE_DIR' bash '$REMOTE_DIR/deploy/activate-supervisor.sh'"
fi
