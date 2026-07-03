#!/usr/bin/env python3
from __future__ import annotations

import json
import mimetypes
import os
import shutil
import subprocess
import tempfile
import uuid
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import quote, unquote, urlparse


ROOT = Path(__file__).resolve().parent
DIST_DIR = ROOT / "dist"
RUNTIME_DIR = ROOT / ".runtime"
QUEUE_SCRIPT = ROOT / "scripts" / "generation-queue.mjs"


def load_dotenv() -> None:
    env_path = ROOT / ".env"
    if not env_path.exists():
        return
    for raw_line in env_path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        key = key.strip()
        value = value.strip().strip('"').strip("'")
        os.environ.setdefault(key, value)


load_dotenv()


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def output_dir() -> Path:
    return (ROOT / os.environ.get("OUTPUT_DIR", "output")).resolve()


def read_json_body(handler: BaseHTTPRequestHandler) -> dict:
    length = int(handler.headers.get("Content-Length") or 0)
    if length <= 0:
        return {}
    raw = handler.rfile.read(length).decode("utf-8")
    return json.loads(raw or "{}")


def send_json(handler: BaseHTTPRequestHandler, status: int, payload) -> None:
    body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    handler.send_response(status)
    handler.send_header("Content-Type", "application/json; charset=utf-8")
    handler.send_header("Content-Length", str(len(body)))
    handler.end_headers()
    handler.wfile.write(body)


def send_error_json(handler: BaseHTTPRequestHandler, status: int, message: str) -> None:
    send_json(handler, status, {"error": message})


def route_provider(kind: str) -> str:
    if kind in {"text", "image"}:
        return "sub2api"
    if kind in {"video", "audio"}:
        return "anycap"
    return "local"


def route_model(kind: str, requested: str) -> str:
    requested = requested or ""
    if requested and not requested.startswith("mock-") and not requested.startswith("local-"):
        return requested
    if kind == "text":
        return os.environ.get("SUB2API_TEXT_MODEL", "gpt-4o-mini")
    if kind == "image":
        return os.environ.get("SUB2API_IMAGE_MODEL", "gpt-image-2")
    if kind == "video":
        return os.environ.get("ANYCAP_VIDEO_MODEL", "seedance-2-fast")
    if kind == "audio":
        return os.environ.get("ANYCAP_AUDIO_MODEL", "anycap-audio")
    return requested or "local-preview"


def run_queue(command: str, *args: str, timeout: int = 12):
    if not QUEUE_SCRIPT.exists():
        raise RuntimeError("任务队列脚本不存在")
    result = subprocess.run(
        ["node", str(QUEUE_SCRIPT), command, *args],
        cwd=ROOT,
        text=True,
        capture_output=True,
        timeout=timeout,
        env=os.environ.copy(),
        check=False,
    )
    stdout = (result.stdout or "").strip()
    stderr = (result.stderr or "").strip()
    try:
        payload = json.loads(stdout.splitlines()[-1]) if stdout else {}
    except json.JSONDecodeError:
        payload = {"error": stdout or stderr or "队列返回了不可解析的数据"}
    if result.returncode != 0:
        raise RuntimeError(str(payload.get("error") or stderr or "后台任务不可用"))
    return payload


def queue_available() -> tuple[bool, str]:
    try:
        health = run_queue("health", timeout=5)
        if health.get("available"):
            return True, ""
        return False, "Redis 已连接，但 media worker 未启动"
    except Exception as error:
        return False, str(error)


def create_job(payload: dict):
    available, reason = queue_available()
    if not available:
        raise RuntimeError(reason)
    kind = str(payload.get("kind") or "text")
    created_at = now_iso()
    job = {
        "id": f"job_{uuid.uuid4().hex[:14]}",
        "nodeId": str(payload.get("nodeId") or ""),
        "kind": kind,
        "title": str(payload.get("title") or kind),
        "provider": route_provider(kind),
        "model": route_model(kind, str(payload.get("model") or "")),
        "status": "queued",
        "progress": 0,
        "prompt": str(payload.get("prompt") or ""),
        "inputs": payload.get("inputs") if isinstance(payload.get("inputs"), list) else [],
        "createdAt": created_at,
        "updatedAt": created_at,
    }
    RUNTIME_DIR.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile("w", suffix=".json", dir=RUNTIME_DIR, delete=False, encoding="utf-8") as temp:
        json.dump(job, temp, ensure_ascii=False)
        temp_path = temp.name
    try:
        return run_queue("enqueue", temp_path, timeout=12)
    finally:
        Path(temp_path).unlink(missing_ok=True)


MEDIA_TYPES = {
    ".png": "image",
    ".jpg": "image",
    ".jpeg": "image",
    ".webp": "image",
    ".gif": "image",
    ".svg": "image",
    ".mp4": "video",
    ".webm": "video",
    ".mov": "video",
    ".m4v": "video",
    ".mp3": "audio",
    ".wav": "audio",
    ".m4a": "audio",
    ".aac": "audio",
}


def list_output_files():
    base = output_dir()
    if not base.exists():
        return []
    files = []
    for path in base.rglob("*"):
        if not path.is_file():
            continue
        media_type = MEDIA_TYPES.get(path.suffix.lower(), "other")
        if media_type == "other":
            continue
        rel = path.relative_to(base).as_posix()
        stat = path.stat()
        files.append(
            {
                "id": rel,
                "title": path.stem,
                "type": media_type,
                "url": f"/output/{quote(rel)}",
                "path": str(path),
                "size": stat.st_size,
                "createdAt": datetime.fromtimestamp(stat.st_mtime, timezone.utc).isoformat(),
            }
        )
    return sorted(files, key=lambda item: item["createdAt"], reverse=True)


def anycap_available() -> bool:
    return shutil.which(os.environ.get("ANYCAP_BIN", "anycap")) is not None


class SelfCanvasHandler(BaseHTTPRequestHandler):
    server_version = "SelfCanvasBridge/0.1"

    def log_message(self, fmt: str, *args) -> None:
        print(f"[server] {self.address_string()} - {fmt % args}")

    def end_headers(self) -> None:
        self.send_header("Access-Control-Allow-Origin", "*")
        super().end_headers()

    def do_OPTIONS(self) -> None:
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, Authorization")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.end_headers()

    def do_GET(self) -> None:
        parsed = urlparse(self.path)
        path = parsed.path
        if path == "/api/health":
            available, reason = queue_available()
            send_json(
                self,
                200,
                {
                    "status": "ok",
                    "queue": {"available": available, "reason": reason},
                    "outputDir": str(output_dir()),
                },
            )
            return
        if path == "/api/config":
            available, reason = queue_available()
            send_json(
                self,
                200,
                {
                    "sub2api": {
                        "baseUrl": os.environ.get("SUB2API_BASE_URL", "http://10.0.0.239:3000"),
                        "hasApiKey": bool(os.environ.get("SUB2API_API_KEY")),
                        "textModel": os.environ.get("SUB2API_TEXT_MODEL", "gpt-4o-mini"),
                        "imageModel": os.environ.get("SUB2API_IMAGE_MODEL", "gpt-image-2"),
                    },
                    "anycap": {
                        "available": anycap_available(),
                        "bin": os.environ.get("ANYCAP_BIN", "anycap"),
                        "videoModel": os.environ.get("ANYCAP_VIDEO_MODEL", "seedance-2-fast"),
                        "audioModel": os.environ.get("ANYCAP_AUDIO_MODEL", ""),
                    },
                    "queue": {"available": available, "reason": reason},
                },
            )
            return
        if path == "/api/generation/jobs":
            try:
                send_json(self, 200, run_queue("list", timeout=8))
            except Exception as error:
                send_error_json(self, 503, str(error))
            return
        if path.startswith("/api/generation/jobs/"):
            job_id = path.rsplit("/", 1)[-1]
            try:
                send_json(self, 200, run_queue("get", job_id, timeout=8))
            except Exception as error:
                send_error_json(self, 404 if "不存在" in str(error) else 503, str(error))
            return
        if path == "/api/files":
            send_json(self, 200, list_output_files())
            return
        if path.startswith("/output/"):
            self.serve_output_file(path)
            return
        self.serve_static(path)

    def do_POST(self) -> None:
        parsed = urlparse(self.path)
        path = parsed.path
        if path == "/api/generation/jobs":
            try:
                send_json(self, 202, create_job(read_json_body(self)))
            except Exception as error:
                send_error_json(self, 503, f"后台任务不可用：{error}")
            return
        if path.startswith("/api/generation/jobs/") and path.endswith("/cancel"):
            job_id = path.split("/")[-2]
            try:
                send_json(self, 200, run_queue("cancel", job_id, timeout=8))
            except Exception as error:
                send_error_json(self, 503, str(error))
            return
        send_error_json(self, 404, "Not found")

    def serve_output_file(self, request_path: str) -> None:
        rel = unquote(request_path[len("/output/") :])
        target = (output_dir() / rel).resolve()
        base = output_dir().resolve()
        if not str(target).startswith(str(base)) or not target.exists() or not target.is_file():
            send_error_json(self, 404, "文件不存在")
            return
        self.send_file(target)

    def serve_static(self, request_path: str) -> None:
        if not DIST_DIR.exists():
            send_error_json(self, 404, "dist 不存在，请先运行 npm run build 或使用 Vite dev server")
            return
        rel = request_path.lstrip("/") or "index.html"
        target = (DIST_DIR / rel).resolve()
        if not str(target).startswith(str(DIST_DIR.resolve())) or not target.exists() or not target.is_file():
            target = DIST_DIR / "index.html"
        self.send_file(target)

    def send_file(self, target: Path) -> None:
        content_type = mimetypes.guess_type(str(target))[0] or "application/octet-stream"
        data = target.read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)


def main() -> None:
    output_dir().mkdir(parents=True, exist_ok=True)
    RUNTIME_DIR.mkdir(parents=True, exist_ok=True)
    host = os.environ.get("SELF_CANVAS_HOST", "127.0.0.1")
    port = int(os.environ.get("SELF_CANVAS_PORT", "8787"))
    server = ThreadingHTTPServer((host, port), SelfCanvasHandler)
    print(f"[server] SelfCanvas bridge listening at http://{host}:{port}")
    print(f"[server] Output directory: {output_dir()}")
    server.serve_forever()


if __name__ == "__main__":
    main()
