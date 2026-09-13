#!/usr/bin/env python3
from __future__ import annotations

import json
import base64
import copy
import hashlib
import hmac
import mimetypes
import os
import re
import secrets
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import uuid
import zipfile
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from http.cookies import SimpleCookie
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import parse_qs, quote, unquote, urljoin, urlparse
from urllib.request import Request, urlopen

import creative_runtime


ROOT = Path(__file__).resolve().parent
DIST_DIR = ROOT / "dist"
RUNTIME_DIR = ROOT / ".runtime"
STORAGE_CONFIG_PATH = RUNTIME_DIR / "storage.json"
PROJECT_STATE_PATH = RUNTIME_DIR / "project.json"
QUEUE_SCRIPT = ROOT / "scripts" / "generation-queue.mjs"
VIDEO_EDIT_QUEUE_SCRIPT = ROOT / "scripts" / "video-edit-queue.mjs"
IDEMPOTENCY_PATH = RUNTIME_DIR / "idempotency.json"
MANAGED_JOBS_PATH = RUNTIME_DIR / "managed-jobs.json"
ARTIFACT_SECRET_PATH = RUNTIME_DIR / "artifact-secret"
MOBILE_SESSIONS_PATH = RUNTIME_DIR / "mobile-sessions.json"
PROJECT_STATE_LOCK = threading.RLock()
IDEMPOTENCY_LOCK = threading.RLock()
EXPORT_JOBS_LOCK = threading.RLock()
MANAGED_JOBS_LOCK = threading.RLock()
BROWSER_SESSIONS_LOCK = threading.RLock()
MOBILE_SESSIONS_LOCK = threading.RLock()
CREATIVE_RUNS_LOCK = threading.RLock()
CREATIVE_RUN_SLOTS = threading.BoundedSemaphore(2)
PROJECT_EVENT_CONDITION = threading.Condition()
EXPORT_JOBS: dict[str, dict] = {}
BROWSER_SESSIONS: dict[str, dict] = {}
MAX_PROJECT_BYTES = 16 * 1024 * 1024
MAX_COMMAND_OPERATIONS = 50
BROWSER_SESSION_TTL_SECONDS = 60 * 60
BROWSER_SESSION_COOKIE = "selfcanvas_session"
ALLOWED_NODE_KINDS = {
    "text", "image", "video", "audio", "stage3d", "panorama", "storyboard", "collage", "asset", "upload"
}


class ProjectRevisionConflict(RuntimeError):
    def __init__(self, record: dict):
        super().__init__("画布记录已被其他浏览器更新")
        self.record = record


def load_dotenv() -> None:
    env_paths = [ROOT / ".env", Path.home() / ".codex" / ".env"]
    for env_path in env_paths:
        if not env_path.exists():
            continue
        for raw_line in env_path.read_text(encoding="utf-8").splitlines():
            line = raw_line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, value = line.split("=", 1)
            key = key.strip()
            value = value.strip().strip('"').strip("'")
            if key and not os.environ.get(key):
                os.environ[key] = value


load_dotenv()


def bounded_env_int(name: str, fallback: int, minimum: int, maximum: int) -> int:
    try:
        return max(minimum, min(maximum, int(os.environ.get(name, str(fallback)))))
    except ValueError:
        return fallback


EXPORT_EXECUTOR = ThreadPoolExecutor(
    max_workers=bounded_env_int("SELF_CANVAS_EXPORT_CONCURRENCY", 2, 1, 4),
    thread_name_prefix="selfcanvas-export",
)


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def read_json_file(path: Path, fallback):
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
        return payload
    except (OSError, json.JSONDecodeError):
        return copy.deepcopy(fallback)


def write_json_atomic(path: Path, payload) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary: Path | None = None
    try:
        with tempfile.NamedTemporaryFile("w", dir=path.parent, delete=False, encoding="utf-8") as temp:
            json.dump(payload, temp, ensure_ascii=False, separators=(",", ":"))
            temp.flush()
            os.fsync(temp.fileno())
            temporary = Path(temp.name)
        os.replace(temporary, path)
        temporary = None
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)


def artifact_secret() -> bytes:
    configured = os.environ.get("SELF_CANVAS_ARTIFACT_SECRET", "").strip()
    if configured:
        return configured.encode("utf-8")
    try:
        secret = ARTIFACT_SECRET_PATH.read_text(encoding="utf-8").strip()
        if secret:
            return secret.encode("ascii")
    except OSError:
        pass
    RUNTIME_DIR.mkdir(parents=True, exist_ok=True)
    secret = uuid.uuid4().hex + uuid.uuid4().hex
    ARTIFACT_SECRET_PATH.write_text(secret, encoding="utf-8")
    try:
        ARTIFACT_SECRET_PATH.chmod(0o600)
    except OSError:
        pass
    return secret.encode("ascii")


def mobile_auth_secret() -> bytes:
    configured = os.environ.get("SELF_CANVAS_MOBILE_AUTH_SECRET", "").strip()
    return configured.encode("utf-8") if configured else artifact_secret()


def encode_token_part(value: bytes) -> str:
    return base64.urlsafe_b64encode(value).decode("ascii").rstrip("=")


def decode_token_part(value: str) -> bytes:
    return base64.urlsafe_b64decode(value + ("=" * (-len(value) % 4)))


def mobile_token(payload: dict) -> str:
    encoded = encode_token_part(json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8"))
    signed = f"scm1.{encoded}"
    signature = hmac.new(mobile_auth_secret(), signed.encode("ascii"), hashlib.sha256).digest()
    return f"{signed}.{encode_token_part(signature)}"


def mobile_token_payload(token: str, expected_type: str) -> dict:
    try:
        prefix, encoded, signature = token.split(".", 2)
        if prefix != "scm1":
            raise ValueError("prefix")
        signed = f"{prefix}.{encoded}"
        expected = hmac.new(mobile_auth_secret(), signed.encode("ascii"), hashlib.sha256).digest()
        actual = decode_token_part(signature)
        if not hmac.compare_digest(actual, expected):
            raise ValueError("signature")
        payload = json.loads(decode_token_part(encoded).decode("utf-8"))
    except (ValueError, UnicodeDecodeError, json.JSONDecodeError) as error:
        raise UploadError(401, "登录状态无效，请重新登录") from error
    if not isinstance(payload, dict) or payload.get("typ") != expected_type:
        raise UploadError(401, "登录状态无效，请重新登录")
    if float(payload.get("exp") or 0) <= time.time():
        raise UploadError(401, "登录已过期，请重新登录")
    if not str(payload.get("sid") or "") or not str(payload.get("sub") or ""):
        raise UploadError(401, "登录状态无效，请重新登录")
    return payload


def read_mobile_sessions_unlocked() -> dict[str, dict]:
    payload = read_json_file(MOBILE_SESSIONS_PATH, {"sessions": {}})
    sessions = payload.get("sessions") if isinstance(payload, dict) else {}
    return sessions if isinstance(sessions, dict) else {}


def write_mobile_sessions_unlocked(sessions: dict[str, dict]) -> None:
    write_json_atomic(MOBILE_SESSIONS_PATH, {"schemaVersion": 1, "sessions": sessions})


def prune_mobile_sessions(sessions: dict[str, dict], timestamp: float | None = None) -> bool:
    current = timestamp if timestamp is not None else time.time()
    expired = [sid for sid, item in sessions.items() if float(item.get("expiresAt") or 0) <= current]
    for sid in expired:
        sessions.pop(sid, None)
    return bool(expired)


def mobile_user_matches(username: str, password: str) -> bool:
    expected_username = os.environ.get("SELF_CANVAS_MOBILE_USERNAME", "internal").strip() or "internal"
    if not hmac.compare_digest(username, expected_username):
        return False
    expected_hash = os.environ.get("SELF_CANVAS_MOBILE_PASSWORD_SHA256", "").strip().lower()
    if expected_hash:
        actual_hash = hashlib.sha256(password.encode("utf-8")).hexdigest()
        return hmac.compare_digest(actual_hash, expected_hash)
    # Backward-compatible fallback for the first internal build. Deployments
    # should set SELF_CANVAS_MOBILE_PASSWORD so the API token is never typed in
    # by an end user.
    expected_password = os.environ.get("SELF_CANVAS_MOBILE_PASSWORD", "").strip()
    if not expected_password:
        expected_password = os.environ.get("SELF_CANVAS_API_TOKEN", "").strip()
    return bool(expected_password and hmac.compare_digest(password, expected_password))


def mobile_auth_ttl(name: str, fallback: int, minimum: int, maximum: int) -> int:
    return bounded_env_int(name, fallback, minimum, maximum)


def issue_mobile_auth_tokens(username: str, session_id: str | None = None) -> tuple[dict, dict]:
    timestamp = time.time()
    access_ttl = mobile_auth_ttl("SELF_CANVAS_MOBILE_ACCESS_TTL_SECONDS", 15 * 60, 5 * 60, 24 * 60 * 60)
    refresh_ttl = mobile_auth_ttl("SELF_CANVAS_MOBILE_REFRESH_TTL_SECONDS", 30 * 24 * 60 * 60, 60 * 60, 180 * 24 * 60 * 60)
    sid = session_id or f"mobile_{uuid.uuid4().hex}"
    access_payload = {
        "typ": "access",
        "sub": username,
        "sid": sid,
        "iat": int(timestamp),
        "exp": int(timestamp + access_ttl),
        "jti": uuid.uuid4().hex,
        "scopes": ["canvas:read", "canvas:write", "generation:read", "generation:run", "artifacts:read"],
    }
    refresh_payload = {
        "typ": "refresh",
        "sub": username,
        "sid": sid,
        "iat": int(timestamp),
        "exp": int(timestamp + refresh_ttl),
        "jti": uuid.uuid4().hex,
    }
    access_token = mobile_token(access_payload)
    refresh_token = mobile_token(refresh_payload)
    session = {
        "username": username,
        "refreshHash": hashlib.sha256(refresh_token.encode("utf-8")).hexdigest(),
        "createdAt": now_iso(),
        "expiresAt": refresh_payload["exp"],
    }
    response = {
        "tokenType": "Bearer",
        "accessToken": access_token,
        "refreshToken": refresh_token,
        "expiresIn": access_ttl,
        "expiresAt": datetime.fromtimestamp(access_payload["exp"], timezone.utc).isoformat(),
        "user": {
            "id": hashlib.sha256(username.encode("utf-8")).hexdigest()[:16],
            "username": username,
            "roles": ["creator"],
        },
    }
    return response, session


def mobile_login(body: dict) -> dict:
    username = str(body.get("username") or "").strip()
    password = str(body.get("password") or "")
    if not username or not password:
        raise UploadError(400, "请输入账号和密码")
    if not mobile_user_matches(username, password):
        # A small constant delay makes trivial credential probing less useful
        # without blocking the threaded server for a noticeable period.
        time.sleep(0.08)
        raise UploadError(401, "账号或密码不正确")
    response, session = issue_mobile_auth_tokens(username)
    sid = mobile_token_payload(response["accessToken"], "access")["sid"]
    with MOBILE_SESSIONS_LOCK:
        sessions = read_mobile_sessions_unlocked()
        prune_mobile_sessions(sessions)
        sessions[sid] = session
        write_mobile_sessions_unlocked(sessions)
    return response


def mobile_refresh(body: dict) -> dict:
    refresh_token = str(body.get("refreshToken") or "").strip()
    if not refresh_token:
        raise UploadError(400, "缺少 refreshToken")
    payload = mobile_token_payload(refresh_token, "refresh")
    session_id = str(payload["sid"])
    username = str(payload["sub"])
    with MOBILE_SESSIONS_LOCK:
        sessions = read_mobile_sessions_unlocked()
        dirty = prune_mobile_sessions(sessions)
        session = sessions.get(session_id)
        expected_hash = str(session.get("refreshHash") or "") if isinstance(session, dict) else ""
        actual_hash = hashlib.sha256(refresh_token.encode("utf-8")).hexdigest()
        if not expected_hash or not hmac.compare_digest(expected_hash, actual_hash):
            if dirty:
                write_mobile_sessions_unlocked(sessions)
            raise UploadError(401, "登录已失效，请重新登录")
        response, next_session = issue_mobile_auth_tokens(username, session_id)
        next_session["createdAt"] = session.get("createdAt") or now_iso()
        sessions[session_id] = next_session
        write_mobile_sessions_unlocked(sessions)
    return response


def mobile_logout(handler: BaseHTTPRequestHandler, body: dict) -> dict:
    session_id = ""
    authorization = str(handler.headers.get("Authorization") or "")
    access_token = authorization[7:].strip() if authorization.lower().startswith("bearer ") else ""
    refresh_token = str(body.get("refreshToken") or "").strip()
    for token, token_type in ((access_token, "access"), (refresh_token, "refresh")):
        if not token:
            continue
        try:
            session_id = str(mobile_token_payload(token, token_type).get("sid") or "")
            if session_id:
                break
        except UploadError:
            continue
    if session_id:
        with MOBILE_SESSIONS_LOCK:
            sessions = read_mobile_sessions_unlocked()
            sessions.pop(session_id, None)
            prune_mobile_sessions(sessions)
            write_mobile_sessions_unlocked(sessions)
    return {"ok": True}


def artifact_id_for_relative(relative: str) -> str:
    normalized = Path(relative.replace("\\", "/")).as_posix().lstrip("/")
    encoded = base64.urlsafe_b64encode(normalized.encode("utf-8")).decode("ascii").rstrip("=")
    signature = hmac.new(artifact_secret(), encoded.encode("ascii"), hashlib.sha256).hexdigest()[:24]
    return f"{encoded}.{signature}"


def relative_from_artifact_id(artifact_id: str) -> str:
    try:
        encoded, signature = artifact_id.rsplit(".", 1)
    except ValueError as error:
        raise UploadError(404, "文件不存在") from error
    expected = hmac.new(artifact_secret(), encoded.encode("ascii"), hashlib.sha256).hexdigest()[:24]
    if not hmac.compare_digest(signature, expected):
        raise UploadError(404, "文件不存在")
    try:
        padding = "=" * (-len(encoded) % 4)
        relative = base64.urlsafe_b64decode(encoded + padding).decode("utf-8")
    except (ValueError, UnicodeDecodeError) as error:
        raise UploadError(404, "文件不存在") from error
    return relative


def output_target_from_relative(relative: str) -> Path:
    target = (output_dir() / relative).resolve()
    if not is_inside_output(target) or not target.exists() or not target.is_file():
        raise UploadError(404, "文件不存在")
    return target


def output_target_from_artifact_id(artifact_id: str) -> Path:
    return output_target_from_relative(relative_from_artifact_id(artifact_id))


def publish_project_event(record: dict, event_type: str = "project.updated", details: dict | None = None) -> None:
    event = {
        "type": event_type,
        "revision": int(record.get("revision") or 0),
        "savedAt": str(record.get("savedAt") or now_iso()),
        **(details or {}),
    }
    with PROJECT_EVENT_CONDITION:
        PROJECT_EVENT_CONDITION.event = event  # type: ignore[attr-defined]
        PROJECT_EVENT_CONDITION.notify_all()


def read_storage_config() -> dict:
    try:
        payload = json.loads(STORAGE_CONFIG_PATH.read_text(encoding="utf-8"))
        return payload if isinstance(payload, dict) else {}
    except (OSError, json.JSONDecodeError):
        return {}


def configured_save_root() -> Path | None:
    managed_root = os.environ.get("SELF_CANVAS_STORAGE_ROOT", "").strip()
    if managed_root:
        return Path(managed_root).expanduser().resolve()
    raw = str(read_storage_config().get("saveRoot") or "").strip()
    if not raw:
        return None
    return Path(raw).expanduser().resolve()


def output_dir() -> Path:
    save_root = configured_save_root()
    if save_root:
        return (save_root / "output").resolve()
    return (ROOT / os.environ.get("OUTPUT_DIR", "output")).resolve()


def storage_payload() -> dict:
    root = configured_save_root()
    return {
        "saveRoot": str(root) if root else "",
        "outputDir": str(output_dir()),
    }


def apply_storage_root(raw_root: str) -> dict:
    value = (raw_root or "").strip()
    if not value:
        STORAGE_CONFIG_PATH.unlink(missing_ok=True)
        output_dir().mkdir(parents=True, exist_ok=True)
        return storage_payload()

    root = Path(value).expanduser()
    if not root.is_absolute():
        raise RuntimeError("保存根目录必须使用绝对路径")
    root = root.resolve()
    output = root / "output"
    output.mkdir(parents=True, exist_ok=True)
    probe = output / f".selfcanvas-write-{uuid.uuid4().hex}.tmp"
    try:
        probe.write_bytes(b"")
    finally:
        probe.unlink(missing_ok=True)

    RUNTIME_DIR.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile("w", dir=RUNTIME_DIR, delete=False, encoding="utf-8") as temp:
        json.dump({"saveRoot": str(root)}, temp, ensure_ascii=False)
        temporary = Path(temp.name)
    os.replace(temporary, STORAGE_CONFIG_PATH)
    return storage_payload()


def choose_storage_root() -> dict:
    if sys.platform != "darwin":
        raise RuntimeError("当前系统不支持原生目录选择，请手动输入绝对路径后点击应用")
    result = subprocess.run(
        ["osascript", "-e", 'POSIX path of (choose folder with prompt "选择 SelfCanvas 保存目录")'],
        capture_output=True,
        text=True,
        timeout=180,
        check=False,
    )
    selected = result.stdout.strip()
    if result.returncode != 0 or not selected:
        raise RuntimeError("已取消目录选择")
    return apply_storage_root(selected)


def read_json_body(handler: BaseHTTPRequestHandler) -> dict:
    length = int(handler.headers.get("Content-Length") or 0)
    if length <= 0:
        return {}
    if length > MAX_PROJECT_BYTES:
        raise RuntimeError("请求内容过大")
    raw = handler.rfile.read(length).decode("utf-8")
    return json.loads(raw or "{}")


def validate_project(project) -> dict:
    if not isinstance(project, dict):
        raise RuntimeError("画布记录格式无效")
    canvases = project.get("canvases")
    active_canvas_id = str(project.get("activeCanvasId") or "").strip()
    if not isinstance(canvases, list) or not canvases:
        raise RuntimeError("画布记录至少需要一个画布")
    if len(canvases) > 200:
        raise RuntimeError("画布记录数量超过限制")
    canvas_ids = {str(canvas.get("id") or "") for canvas in canvases if isinstance(canvas, dict)}
    if not active_canvas_id or active_canvas_id not in canvas_ids:
        raise RuntimeError("当前画布不存在")
    return project


def empty_project_record() -> dict:
    return {"schemaVersion": 1, "revision": 0, "savedAt": "", "project": None}


def read_project_record_unlocked() -> dict:
    try:
        payload = json.loads(PROJECT_STATE_PATH.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return empty_project_record()
    if not isinstance(payload, dict):
        raise RuntimeError("服务器画布记录已损坏")
    if "project" not in payload:
        return {
            "schemaVersion": 1,
            "revision": 1,
            "savedAt": str(payload.get("updatedAt") or ""),
            "project": validate_project(payload),
        }
    project = payload.get("project")
    if project is not None:
        project = validate_project(project)
    return {
        "schemaVersion": 1,
        "revision": max(0, int(payload.get("revision") or 0)),
        "savedAt": str(payload.get("savedAt") or ""),
        "project": project,
    }


def read_project_record() -> dict:
    with PROJECT_STATE_LOCK:
        return read_project_record_unlocked()


def save_project_state(project, base_revision: int) -> dict:
    validated = validate_project(project)
    with PROJECT_STATE_LOCK:
        current = read_project_record_unlocked()
        if int(base_revision) != int(current["revision"]):
            raise ProjectRevisionConflict(current)
        record = {
            "schemaVersion": 1,
            "revision": int(current["revision"]) + 1,
            "savedAt": now_iso(),
            "project": validated,
        }
        write_json_atomic(PROJECT_STATE_PATH, record)
    publish_project_event(record)
    return record


def sanitize_public_value(value):
    if isinstance(value, list):
        return [sanitize_public_value(item) for item in value]
    if not isinstance(value, dict):
        return value
    blocked = {"path", "apiKey", "endpoint", "command", "args", "secret", "password", "token"}
    clean = {}
    for key, item in value.items():
        if key in blocked or any(fragment in key.lower() for fragment in ("apikey", "accesskey", "secret", "password")):
            continue
        clean[key] = sanitize_public_value(item)
    return clean


def require_project_canvas(record: dict, canvas_id: str) -> tuple[dict, dict]:
    project = record.get("project")
    if not isinstance(project, dict):
        raise UploadError(404, "画布项目不存在")
    canvas = next(
        (item for item in project.get("canvases", []) if isinstance(item, dict) and str(item.get("id")) == canvas_id),
        None,
    )
    if not canvas:
        raise UploadError(404, "画布不存在")
    return project, canvas


def find_canvas_node(canvas: dict, node_id: str) -> dict:
    node = next(
        (item for item in canvas.get("nodes", []) if isinstance(item, dict) and str(item.get("id")) == node_id),
        None,
    )
    if not node:
        raise UploadError(404, "节点不存在")
    return node


def pagination_values(query: dict[str, list[str]]) -> tuple[int, int]:
    try:
        cursor = max(0, int((query.get("cursor") or ["0"])[0] or 0))
    except ValueError:
        cursor = 0
    try:
        limit = max(1, min(50, int((query.get("limit") or ["20"])[0] or 20)))
    except ValueError:
        limit = 20
    return cursor, limit


def canvases_v2(query: dict[str, list[str]]) -> dict:
    record = read_project_record()
    project = record.get("project") or {}
    canvases = []
    for canvas in project.get("canvases", []) if isinstance(project, dict) else []:
        if not isinstance(canvas, dict):
            continue
        canvases.append(
            {
                "id": str(canvas.get("id") or ""),
                "name": str(canvas.get("name") or "未命名画布"),
                "nodeCount": len(canvas.get("nodes") or []),
                "edgeCount": len(canvas.get("edges") or []),
                "updatedAt": str(canvas.get("updatedAt") or ""),
                "active": str(project.get("activeCanvasId") or "") == str(canvas.get("id") or ""),
            }
        )
    cursor, limit = pagination_values(query)
    items = canvases[cursor : cursor + limit]
    next_cursor = cursor + limit if cursor + limit < len(canvases) else None
    return {
        "projectId": str(project.get("id") or "") if isinstance(project, dict) else "",
        "revision": int(record.get("revision") or 0),
        "canvases": items,
        "nextCursor": str(next_cursor) if next_cursor is not None else None,
    }


def canvas_v2(canvas_id: str, query: dict[str, list[str]]) -> dict:
    record = read_project_record()
    project, canvas = require_project_canvas(record, canvas_id)
    cursor, limit = pagination_values(query)
    nodes = canvas.get("nodes") if isinstance(canvas.get("nodes"), list) else []
    page = nodes[cursor : cursor + limit]
    next_cursor = cursor + limit if cursor + limit < len(nodes) else None
    return {
        "projectId": str(project.get("id") or ""),
        "revision": int(record.get("revision") or 0),
        "canvas": {
            "id": canvas_id,
            "name": str(canvas.get("name") or "未命名画布"),
            "updatedAt": str(canvas.get("updatedAt") or ""),
            "viewport": sanitize_public_value(canvas.get("viewport") or {}),
            "edges": sanitize_public_value(canvas.get("edges") or []),
            "groups": sanitize_public_value(canvas.get("groups") or []),
        },
        "nodes": sanitize_public_value(page),
        "nextCursor": str(next_cursor) if next_cursor is not None else None,
    }


def search_canvas_nodes_v2(canvas_id: str, query: dict[str, list[str]]) -> dict:
    record = read_project_record()
    _, canvas = require_project_canvas(record, canvas_id)
    needle = str((query.get("q") or [""])[0] or "").strip().lower()
    kinds = {str(value) for value in query.get("kind", []) if str(value)}
    matches = []
    for node in canvas.get("nodes", []):
        if not isinstance(node, dict):
            continue
        data = node.get("data") if isinstance(node.get("data"), dict) else {}
        kind = str(data.get("kind") or "")
        imported_media = data.get("importedMedia") if isinstance(data.get("importedMedia"), dict) else {}
        outputs = data.get("outputs") if isinstance(data.get("outputs"), dict) else {}
        references = data.get("references") if isinstance(data.get("references"), list) else []
        haystack = " ".join(
            [
                *(str(data.get(key) or "") for key in ("title", "prompt", "model", "provider")),
                str(imported_media.get("name") or ""),
                str(outputs.get("assetName") or ""),
                str(outputs.get("text") or ""),
                *(str(reference.get("title") or "") for reference in references if isinstance(reference, dict)),
            ]
        ).lower()
        if kinds and kind not in kinds:
            continue
        if needle and needle not in haystack:
            continue
        matches.append(node)
    cursor, limit = pagination_values(query)
    page = matches[cursor : cursor + limit]
    next_cursor = cursor + limit if cursor + limit < len(matches) else None
    return {
        "canvasId": canvas_id,
        "revision": int(record.get("revision") or 0),
        "nodes": sanitize_public_value(page),
        "nextCursor": str(next_cursor) if next_cursor is not None else None,
    }


def idempotency_lookup(key: str) -> dict | None:
    payload = read_json_file(IDEMPOTENCY_PATH, {})
    if not isinstance(payload, dict):
        return None
    value = payload.get(key)
    if not isinstance(value, dict):
        return None
    if isinstance(value.get("result"), dict):
        return copy.deepcopy(value["result"])
    # Compatibility with entries written before the cache envelope existed.
    legacy = copy.deepcopy(value)
    legacy.pop("idempotencySavedAt", None)
    return legacy


def idempotency_remember(key: str, result: dict) -> None:
    payload = read_json_file(IDEMPOTENCY_PATH, {})
    if not isinstance(payload, dict):
        payload = {}
    payload[key] = {"result": copy.deepcopy(result), "savedAt": now_iso()}
    if len(payload) > 1000:
        ordered = sorted(
            payload.items(),
            key=lambda item: str(item[1].get("savedAt") or item[1].get("idempotencySavedAt") or ""),
        )
        payload = dict(ordered[-800:])
    write_json_atomic(IDEMPOTENCY_PATH, payload)


def require_request_id(body: dict) -> str:
    value = str(body.get("requestId") or "").strip()
    if not re.fullmatch(r"[A-Za-z0-9._:-]{8,128}", value):
        raise UploadError(400, "requestId 格式无效")
    return value


def build_canvas_node(raw: dict) -> dict:
    kind = str(raw.get("kind") or "").strip()
    if kind not in ALLOWED_NODE_KINDS:
        raise UploadError(400, "节点类型无效")
    node_id = str(raw.get("id") or f"{kind}_{uuid.uuid4().hex[:12]}")
    if not re.fullmatch(r"[A-Za-z0-9._:-]{1,160}", node_id):
        raise UploadError(400, "节点 ID 无效")
    title = str(raw.get("title") or kind).strip()[:200]
    prompt = str(raw.get("prompt") or "")[:20_000]
    position = raw.get("position") if isinstance(raw.get("position"), dict) else {}
    try:
        x, y = float(position.get("x") or 0), float(position.get("y") or 0)
    except (TypeError, ValueError) as error:
        raise UploadError(400, "节点位置无效") from error
    provider_options = sanitize_options(kind, {"options": raw.get("providerOptions") or {}})
    provider = str(raw.get("provider") or ("AnyCap" if kind in {"video", "audio"} else "Sub2API"))[:100]
    model = route_model(kind, str(raw.get("model") or ""))[:200]
    return {
        "id": node_id,
        "type": "studioNode",
        "position": {"x": x, "y": y},
        "width": 318 if kind == "video" else 286,
        "height": 238 if kind == "video" else 220,
        "data": {
            "kind": kind,
            "title": title or kind,
            "prompt": prompt,
            "status": "idle",
            "progress": 0,
            "provider": provider,
            "model": model,
            "inputs": [],
            "outputs": {},
            "references": [],
            "providerOptions": provider_options,
            "error": "",
        },
    }


def canvas_node_output_type(node: dict) -> str:
    data = node.get("data") if isinstance(node.get("data"), dict) else {}
    outputs = data.get("outputs") if isinstance(data.get("outputs"), dict) else {}
    if outputs.get("videoUrl"):
        return "video"
    if outputs.get("audioUrl"):
        return "audio"
    if outputs.get("imageUrl"):
        return "image"
    if outputs.get("text"):
        return "text"
    kind = str(data.get("kind") or "")
    if kind == "video":
        return "video"
    if kind == "audio":
        return "audio"
    if kind in {"image", "asset", "upload"}:
        return "image"
    if kind in {"text", "storyboard"}:
        return "text"
    return "other"


def canvas_node_to_reference(node: dict) -> dict:
    """Mirror src/utils/nodeReferences.ts nodeToReference for trusted canvas nodes."""
    data = node.get("data") if isinstance(node.get("data"), dict) else {}
    outputs = data.get("outputs") if isinstance(data.get("outputs"), dict) else {}
    imported_media = data.get("importedMedia") if isinstance(data.get("importedMedia"), dict) else {}
    output_type = canvas_node_output_type(node)
    if output_type not in {"image", "video", "audio", "text"}:
        raise UploadError(400, f"节点 {str(node.get('id') or '')} 没有可引用的图片、视频、音频或文本输出")
    url = str(
        outputs.get("imageUrl")
        or outputs.get("videoUrl")
        or outputs.get("audioUrl")
        or outputs.get("fileUrl")
        or ""
    )
    title = str(
        outputs.get("assetName")
        or imported_media.get("name")
        or data.get("title")
        or data.get("prompt")
        or node.get("id")
        or "未命名"
    )
    reference = {
        "nodeId": str(node.get("id") or ""),
        "title": title,
        "kind": str(data.get("kind") or "other"),
        "outputType": output_type,
        "source": "canvas",
    }
    if url:
        reference["url"] = url
    raw_path = str(imported_media.get("path") or "")
    if raw_path:
        reference["path"] = raw_path
    if output_type in {"image", "video"} and url:
        reference["thumbnailUrl"] = url
    if output_type == "text":
        content = str(outputs.get("text") or "").strip()
        if content:
            reference["content"] = content
    return reference


def canvas_reference_key(reference: dict) -> str:
    source = str(reference.get("source") or "canvas")
    group_id = str(reference.get("groupId") or "solo")
    return f"{source}:{group_id}:{str(reference.get('nodeId') or '')}"


def utf16_length(value: str) -> int:
    return len(value.encode("utf-16-le")) // 2


def utf16_slice(value: str, start: int, end: int) -> str | None:
    boundaries = {0: 0}
    offset = 0
    for index, character in enumerate(value):
        offset += utf16_length(character)
        boundaries[offset] = index + 1
    if start not in boundaries or end not in boundaries:
        return None
    return value[boundaries[start] : boundaries[end]]


def valid_prompt_mentions(prompt: str, references: list[dict], raw_mentions) -> list[dict]:
    if not isinstance(raw_mentions, list):
        return []
    reference_keys = {canvas_reference_key(reference) for reference in references if isinstance(reference, dict)}
    candidates = []
    for raw in raw_mentions:
        if not isinstance(raw, dict):
            continue
        reference_key = str(raw.get("referenceKey") or "")
        text = str(raw.get("text") or "")
        start, end = raw.get("start"), raw.get("end")
        if (
            reference_key not in reference_keys
            or not text
            or isinstance(start, bool)
            or isinstance(end, bool)
            or not isinstance(start, int)
            or not isinstance(end, int)
            or start < 0
            or end <= start
            or utf16_slice(prompt, start, end) != text
        ):
            continue
        candidates.append(
            {
                "id": str(raw.get("id") or f"mention_{uuid.uuid4().hex}"),
                "referenceKey": reference_key,
                "text": text,
                "start": start,
                "end": end,
            }
        )
    candidates.sort(key=lambda mention: (mention["start"], mention["end"]))
    valid = []
    for mention in candidates:
        if valid and mention["start"] < valid[-1]["end"]:
            continue
        valid.append(mention)
    return valid


def safe_reference_mention_title(reference: dict) -> str:
    title = re.sub(r"\s+", " ", str(reference.get("title") or "")).strip().replace("@", "＠")
    return (title or str(reference.get("nodeId") or "未命名素材"))[:160]


def unique_reference_mention_text(prompt: str, reference: dict, used_texts: set[str]) -> str:
    base = safe_reference_mention_title(reference)
    candidate = f"@{base}"
    if candidate not in used_texts and candidate not in prompt:
        return candidate
    node_id = str(reference.get("nodeId") or "source")
    suffix = node_id[-24:]
    candidate = f"@{base} · {suffix}"
    serial = 2
    while candidate in used_texts or candidate in prompt:
        candidate = f"@{base} · {suffix}-{serial}"
        serial += 1
    return candidate


def merge_canvas_references(existing, additions: list[dict]) -> list[dict]:
    merged = [copy.deepcopy(reference) for reference in existing if isinstance(reference, dict)] if isinstance(existing, list) else []
    index_by_key = {canvas_reference_key(reference): index for index, reference in enumerate(merged)}
    for reference in additions:
        key = canvas_reference_key(reference)
        if key in index_by_key:
            merged[index_by_key[key]] = reference
        else:
            index_by_key[key] = len(merged)
            merged.append(reference)
    return merged


def bind_canvas_references(canvas: dict, operation: dict, edges: list[dict]) -> None:
    allowed_fields = {"type", "targetNodeId", "sourceNodeIds", "ensureEdges", "appendMentions"}
    unknown_fields = set(operation) - allowed_fields
    if unknown_fields:
        raise UploadError(400, f"bind_references 包含不支持的字段：{', '.join(sorted(unknown_fields))}")
    target_id = operation.get("targetNodeId")
    source_ids = operation.get("sourceNodeIds")
    if not isinstance(target_id, str) or not re.fullmatch(r"[A-Za-z0-9._:-]{1,160}", target_id):
        raise UploadError(400, "targetNodeId 格式无效")
    if not isinstance(source_ids, list) or not 1 <= len(source_ids) <= 9:
        raise UploadError(400, "sourceNodeIds 必须包含 1–9 个节点 ID")
    if any(not isinstance(node_id, str) or not re.fullmatch(r"[A-Za-z0-9._:-]{1,160}", node_id) for node_id in source_ids):
        raise UploadError(400, "sourceNodeIds 格式无效")
    if len(set(source_ids)) != len(source_ids):
        raise UploadError(400, "sourceNodeIds 不可重复")
    if target_id in source_ids:
        raise UploadError(400, "不能将节点引用到自身")
    for field in ("ensureEdges", "appendMentions"):
        if field in operation and not isinstance(operation[field], bool):
            raise UploadError(400, f"{field} 必须是布尔值")
    ensure_edges = operation.get("ensureEdges", True)
    append_mentions = operation.get("appendMentions", True)

    target = find_canvas_node(canvas, target_id)
    sources = [find_canvas_node(canvas, source_id) for source_id in source_ids]
    additions = [canvas_node_to_reference(source) for source in sources]
    target_data = target.setdefault("data", {})
    references = merge_canvas_references(target_data.get("references"), additions)
    target_data["references"] = references

    if append_mentions:
        prompt = str(target_data.get("prompt") or "")
        mentions = valid_prompt_mentions(prompt, references, target_data.get("referenceMentions"))
        mentioned_keys = {mention["referenceKey"] for mention in mentions}
        used_texts = {mention["text"] for mention in mentions}
        for reference in additions:
            reference_key = canvas_reference_key(reference)
            if reference_key in mentioned_keys:
                continue
            mention_text = unique_reference_mention_text(prompt, reference, used_texts)
            separator = " " if prompt and not prompt[-1].isspace() else ""
            start = utf16_length(prompt + separator)
            next_prompt = f"{prompt}{separator}{mention_text}"
            if utf16_length(next_prompt) > 20_000:
                raise UploadError(400, "追加引用后 prompt 超过 20,000 字符限制")
            mentions.append(
                {
                    "id": f"mention_{uuid.uuid4().hex}",
                    "referenceKey": reference_key,
                    "text": mention_text,
                    "start": start,
                    "end": start + utf16_length(mention_text),
                }
            )
            mentioned_keys.add(reference_key)
            used_texts.add(mention_text)
            prompt = next_prompt
        target_data["prompt"] = prompt
        target_data["referenceMentions"] = mentions

    if ensure_edges:
        for source_id in source_ids:
            if not any(
                str(edge.get("source")) == source_id and str(edge.get("target")) == target_id
                and not (isinstance(edge.get("data"), dict) and edge["data"].get("sourceGroupId"))
                for edge in edges
                if isinstance(edge, dict)
            ):
                edges.append(
                    {
                        "id": f"edge_{uuid.uuid4().hex[:12]}",
                        "source": source_id,
                        "target": target_id,
                        "type": "default",
                    }
                )


def apply_canvas_operations(canvas_id: str, body: dict) -> dict:
    request_id = require_request_id(body)
    key = f"operations:{canvas_id}:{request_id}"
    with IDEMPOTENCY_LOCK:
        cached = idempotency_lookup(key)
        if cached:
            return cached
        operations = body.get("operations")
        if not isinstance(operations, list) or not operations or len(operations) > MAX_COMMAND_OPERATIONS:
            raise UploadError(400, f"operations 必须包含 1–{MAX_COMMAND_OPERATIONS} 项")
        with PROJECT_STATE_LOCK:
            current = read_project_record_unlocked()
            try:
                base_revision = int(body.get("baseRevision"))
            except (TypeError, ValueError) as error:
                raise UploadError(400, "baseRevision 无效") from error
            if base_revision != int(current.get("revision") or 0):
                raise ProjectRevisionConflict(current)
            project = copy.deepcopy(current.get("project"))
            if not isinstance(project, dict):
                raise UploadError(404, "画布项目不存在")
            _, canvas = require_project_canvas({"project": project}, canvas_id)
            nodes = canvas.setdefault("nodes", [])
            edges = canvas.setdefault("edges", [])
            focus_node_id = ""
            for operation in operations:
                if not isinstance(operation, dict):
                    raise UploadError(400, "operation 格式无效")
                operation_type = str(operation.get("type") or "")
                if operation_type == "rename_canvas":
                    name = str(operation.get("name") or "").strip()[:120]
                    if not name:
                        raise UploadError(400, "画布名称不能为空")
                    canvas["name"] = name
                elif operation_type == "add_node":
                    node = build_canvas_node(operation.get("node") if isinstance(operation.get("node"), dict) else {})
                    if any(str(item.get("id")) == node["id"] for item in nodes if isinstance(item, dict)):
                        raise UploadError(409, "节点 ID 已存在")
                    nodes.append(node)
                elif operation_type == "update_node":
                    node = find_canvas_node(canvas, str(operation.get("nodeId") or ""))
                    patch = operation.get("patch") if isinstance(operation.get("patch"), dict) else {}
                    unknown = set(patch) - {"title", "prompt", "provider", "model", "providerOptions"}
                    if unknown or not patch:
                        raise UploadError(400, "节点 patch 包含不支持的字段")
                    data = node.setdefault("data", {})
                    if "title" in patch:
                        title = str(patch.get("title") or "").strip()[:200]
                        if not title:
                            raise UploadError(400, "节点标题不能为空")
                        data["title"] = title
                    if "prompt" in patch:
                        data["prompt"] = str(patch.get("prompt") or "")[:20_000]
                    if "provider" in patch:
                        data["provider"] = str(patch.get("provider") or "")[:100]
                    if "model" in patch:
                        data["model"] = str(patch.get("model") or "")[:200]
                    if "providerOptions" in patch:
                        data["providerOptions"] = sanitize_options(
                            str(data.get("kind") or "text"), {"options": patch.get("providerOptions") or {}}
                        )
                elif operation_type == "bind_references":
                    bind_canvas_references(canvas, operation, edges)
                elif operation_type == "move_node":
                    node = find_canvas_node(canvas, str(operation.get("nodeId") or ""))
                    position = operation.get("position") if isinstance(operation.get("position"), dict) else {}
                    try:
                        node["position"] = {"x": float(position["x"]), "y": float(position["y"])}
                    except (KeyError, TypeError, ValueError) as error:
                        raise UploadError(400, "节点位置无效") from error
                elif operation_type == "add_edge":
                    source = str(operation.get("sourceNodeId") or "")
                    target = str(operation.get("targetNodeId") or "")
                    if source == target:
                        raise UploadError(400, "不能连接节点自身")
                    find_canvas_node(canvas, source)
                    find_canvas_node(canvas, target)
                    if not any(str(edge.get("source")) == source and str(edge.get("target")) == target for edge in edges if isinstance(edge, dict)):
                        edges.append({"id": f"edge_{uuid.uuid4().hex[:12]}", "source": source, "target": target, "type": "default"})
                elif operation_type == "set_viewport":
                    viewport = operation.get("viewport") if isinstance(operation.get("viewport"), dict) else {}
                    try:
                        zoom = float(viewport["zoom"])
                        if zoom < 0.05 or zoom > 8:
                            raise ValueError("zoom")
                        canvas["viewport"] = {"x": float(viewport["x"]), "y": float(viewport["y"]), "zoom": zoom}
                    except (KeyError, TypeError, ValueError) as error:
                        raise UploadError(400, "viewport 无效") from error
                elif operation_type == "focus_node":
                    node = find_canvas_node(canvas, str(operation.get("nodeId") or ""))
                    focus_node_id = str(node.get("id") or "")
                    canvas["focusNodeId"] = focus_node_id
                    canvas["focusRequestId"] = request_id
                    canvas["focusRevision"] = int(current.get("revision") or 0) + 1
                    project["activeCanvasId"] = canvas_id
                else:
                    raise UploadError(400, f"不支持的 operation：{operation_type}")
            timestamp = now_iso()
            canvas["updatedAt"] = timestamp
            project["updatedAt"] = timestamp
            record = {
                "schemaVersion": 1,
                "revision": int(current.get("revision") or 0) + 1,
                "savedAt": timestamp,
                "project": validate_project(project),
            }
            write_json_atomic(PROJECT_STATE_PATH, record)
        result = {
            "projectId": str(project.get("id") or ""),
            "canvasId": canvas_id,
            "revision": int(record["revision"]),
            "savedAt": timestamp,
            "requestId": request_id,
            "applied": len(operations),
        }
        idempotency_remember(key, result)
    event_details = {"canvasId": canvas_id, "requestId": request_id}
    if focus_node_id:
        event_details["focusNodeId"] = focus_node_id
        event_details["focusRequestId"] = request_id
    publish_project_event(record, "canvas.operations", event_details)
    return result


def send_json(handler: BaseHTTPRequestHandler, status: int, payload, headers: dict[str, str] | None = None) -> None:
    body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    handler.send_response(status)
    handler.send_header("Content-Type", "application/json; charset=utf-8")
    handler.send_header("Content-Length", str(len(body)))
    for name, value in (headers or {}).items():
        handler.send_header(name, value)
    handler.end_headers()
    handler.wfile.write(body)


def send_error_json(handler: BaseHTTPRequestHandler, status: int, message: str) -> None:
    send_json(handler, status, {"error": message})


def json_from_text(raw: str):
    text = (raw or "").strip()
    if not text:
        return {}
    for line in reversed(text.splitlines()):
        candidate = line.strip()
        if not candidate:
            continue
        try:
            return json.loads(candidate)
        except json.JSONDecodeError:
            continue
    return {"text": text}


def is_http_url(value: str) -> bool:
    return value.startswith("http://") or value.startswith("https://")


def safe_anycap_bin(endpoint: str = "") -> str:
    raw = (endpoint or "").strip()
    if is_http_url(raw):
        return raw
    return raw or os.environ.get("ANYCAP_BIN", "anycap")


def run_anycap_cli(endpoint: str, args: list[str], timeout: int = 12) -> dict:
    command = safe_anycap_bin(endpoint)
    if is_http_url(command):
        return {
            "available": False,
            "installed": False,
            "message": "当前填的是 AnyCap 网关地址，登录和模型扫描第一版只支持本地 CLI。",
        }
    try:
        result = subprocess.run(
            [command, *args],
            cwd=ROOT,
            text=True,
            capture_output=True,
            timeout=timeout,
            env=os.environ.copy(),
            check=False,
        )
    except FileNotFoundError:
        return {
            "available": False,
            "installed": False,
            "bin": command,
            "message": f"找不到 AnyCap CLI：{command}",
        }
    except subprocess.TimeoutExpired:
        return {
            "available": False,
            "installed": True,
            "bin": command,
            "message": "AnyCap CLI 响应超时。",
        }
    stdout = (result.stdout or "").strip()
    stderr = (result.stderr or "").strip()
    payload = json_from_text(stdout) if stdout else {}
    message = (
        str(payload.get("message") or payload.get("error") or payload.get("hint") or "")
        or stderr
        or stdout
        or ("ok" if result.returncode == 0 else "AnyCap CLI 返回失败")
    )
    return {
        "available": result.returncode == 0,
        "installed": True,
        "bin": command,
        "returnCode": result.returncode,
        "message": message,
        "stdout": stdout[-4000:],
        "stderr": stderr[-1200:],
        "payload": payload,
    }


def http_json_request(url: str, api_key: str = "", timeout: int = 8) -> dict:
    headers = {"Accept": "application/json"}
    if api_key:
        headers["Authorization"] = f"Bearer {api_key}"
    request = Request(url, headers=headers)
    try:
        with urlopen(request, timeout=timeout) as response:
            raw = response.read().decode("utf-8", errors="replace")
            payload = json_from_text(raw)
            return {
                "available": 200 <= response.status < 400,
                "statusCode": response.status,
                "payload": payload,
                "message": "连接成功",
            }
    except HTTPError as error:
        raw = error.read().decode("utf-8", errors="replace")
        payload = json_from_text(raw)
        message = str(payload.get("error") or payload.get("message") or f"HTTP {error.code}")
        return {"available": False, "statusCode": error.code, "payload": payload, "message": message}
    except URLError as error:
        return {"available": False, "message": str(error.reason)}
    except Exception as error:
        return {"available": False, "message": str(error)}


def openai_compatible_url(base_url: str, api_path: str) -> str:
    base = (base_url or "").strip().rstrip("/")
    path = api_path if api_path.startswith("/") else f"/{api_path}"
    if base.endswith(path):
        return base
    if base.endswith("/v1") and path.startswith("/v1/"):
        return f"{base}{path[3:]}"
    return f"{base}{path}"


def http_json_post(url: str, payload: dict, api_key: str = "", timeout: int = 35) -> dict:
    headers = {"Accept": "application/json", "Content-Type": "application/json"}
    if api_key:
        headers["Authorization"] = f"Bearer {api_key}"
    data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    request = Request(url, data=data, headers=headers, method="POST")
    try:
        with urlopen(request, timeout=timeout) as response:
            raw = response.read().decode("utf-8", errors="replace")
            return {
                "available": 200 <= response.status < 400,
                "statusCode": response.status,
                "payload": json_from_text(raw),
                "message": "连接成功",
            }
    except HTTPError as error:
        raw = error.read().decode("utf-8", errors="replace")
        payload = json_from_text(raw)
        message = str(payload.get("error") or payload.get("message") or f"HTTP {error.code}")
        if error.code == 503 and "No available compatible accounts" in message:
            message = "Sub2API 已连接，但没有可服务该模型的账号/渠道。请先配置兼容账号。"
        return {"available": False, "statusCode": error.code, "payload": payload, "message": message}
    except URLError as error:
        return {"available": False, "message": str(error.reason)}
    except Exception as error:
        return {"available": False, "message": str(error)}


PROVIDER_TOOL_LABELS = {
    "anycap": "AnyCap",
    "sub2api": "Sub2API",
    "openai-compatible": "OpenAI Compatible",
    "runninghub": "RunningHUB",
}


ANYCAP_VIDEO_MODEL_ALIASES = {
    "h3": "minimax-h3",
    "minimaxh3": "minimax-h3",
    "seedance2mini": "seedance-2-mini",
    "seedance25": "seedance-2.5",
    "seedance2": "seedance-2",
    "seedance20": "seedance-2",
    "seedance20fast": "seedance-2-fast",
    "seedance2fast": "seedance-2-fast",
    "seedancefsat": "seedance-2-fast",
    "seedance15pro": "seedance-1.5-pro",
    "seedance15": "seedance-1.5-pro",
    "seedance2pro": "seedance-2",
    "kling30": "kling-3.0",
    "kling3": "kling-3.0",
    "kling30omni": "kling-3.0-omni",
    "kling3omni": "kling-3.0-omni",
    "klingo1": "kling-o1",
    "kling21": "kling-3.0",
    "veo31": "veo-3.1",
    "veo31fast": "veo-3.1-fast",
    "veo3": "veo-3.1",
    "sora2": "sora-2-pro",
    "sora2pro": "sora-2-pro",
    "hailuo23": "hailuo-2.3",
    "geminiomniflashpreview": "gemini-omni-flash-preview",
}


def number_range(start: int, end: int) -> list[int]:
    return list(range(start, end + 1))


NO_MEDIA_LIMITS = {"image": 0, "video": 0, "audio": 0}
SEEDANCE_RATIOS = ["16:9", "3:4", "21:9", "9:16", "4:3", "1:1"]

ANYCAP_VIDEO_CAPABILITIES = {
    "seedance-2.5": {
        "supportsGenerateAudio": True,
        "mode": "multi-modal-reference",
        "modes": ["multi-modal-reference", "image-to-video", "text-to-video"],
        "resolutions": ["480p", "720p", "1080p"],
        "durations": number_range(4, 15),
        "defaultDuration": 6,
        "aspectRatios": ["3:4", "21:9", "9:16", "16:9", "4:3", "1:1"],
        "references": {"image": 9, "video": 3, "audio": 3},
        "referencesByMode": {
            "text-to-video": NO_MEDIA_LIMITS,
            "image-to-video": {"image": 9, "video": 0, "audio": 0},
            "multi-modal-reference": {"image": 9, "video": 3, "audio": 3},
        },
    },
    "seedance-2-fast": {
        "supportsGenerateAudio": True,
        "mode": "multi-modal-reference",
        "modes": ["multi-modal-reference", "image-to-video", "text-to-video"],
        "resolutions": ["480p", "720p"],
        "durations": number_range(4, 15),
        "defaultDuration": 6,
        "aspectRatios": SEEDANCE_RATIOS,
        "references": {"image": 9, "video": 3, "audio": 3},
        "referencesByMode": {
            "text-to-video": NO_MEDIA_LIMITS,
            "image-to-video": {"image": 9, "video": 3, "audio": 0},
            "multi-modal-reference": {"image": 9, "video": 3, "audio": 3},
        },
    },
    "seedance-2": {
        "supportsGenerateAudio": True,
        "mode": "multi-modal-reference",
        "modes": ["multi-modal-reference", "image-to-video", "text-to-video"],
        "resolutions": ["480p", "720p", "1080p", "4k"],
        "durations": number_range(4, 15),
        "defaultDuration": 6,
        "aspectRatios": ["3:4", "21:9", "9:16", "16:9", "4:3", "1:1"],
        "references": {"image": 9, "video": 3, "audio": 3},
        "referencesByMode": {
            "text-to-video": NO_MEDIA_LIMITS,
            "image-to-video": {"image": 9, "video": 3, "audio": 0},
            "multi-modal-reference": {"image": 9, "video": 3, "audio": 3},
        },
    },
    "seedance-1.5-pro": {
        "supportsGenerateAudio": True,
        "mode": "image-to-video",
        "modes": ["image-to-video", "text-to-video"],
        "resolutions": ["480p", "720p"],
        "durations": number_range(4, 12),
        "defaultDuration": 6,
        "aspectRatios": SEEDANCE_RATIOS,
        "references": {"image": 9, "video": 0, "audio": 0},
        "referencesByMode": {
            "text-to-video": NO_MEDIA_LIMITS,
            "image-to-video": {"image": 9, "video": 0, "audio": 0},
        },
    },
    "kling-3.0": {
        "supportsGenerateAudio": True,
        "mode": "multi-shot-video",
        "modes": ["multi-shot-video", "image-to-video", "text-to-video"],
        "resolutions": ["720p", "1080p", "4k"],
        "durations": number_range(3, 15),
        "defaultDuration": 6,
        "aspectRatios": ["16:9", "9:16", "4:3", "3:4"],
        "references": {"image": 9, "video": 0, "audio": 0},
        "referencesByMode": {
            "text-to-video": NO_MEDIA_LIMITS,
            "image-to-video": {"image": 9, "video": 3, "audio": 0},
            "multi-shot-video": {"image": 9, "video": 0, "audio": 0},
        },
    },
    "kling-3.0-omni": {
        "supportsGenerateAudio": True,
        "mode": "multi-shot-video",
        "modes": ["multi-shot-video", "image-to-video", "text-to-video"],
        "resolutions": ["720p", "1080p"],
        "durations": number_range(3, 15),
        "defaultDuration": 6,
        "aspectRatios": ["16:9", "9:16", "1:1"],
        "references": {"image": 9, "video": 0, "audio": 0},
        "referencesByMode": {
            "text-to-video": NO_MEDIA_LIMITS,
            "image-to-video": {"image": 9, "video": 3, "audio": 0},
            "multi-shot-video": {"image": 9, "video": 0, "audio": 0},
        },
    },
    "kling-o1": {
        "mode": "image-to-video",
        "modes": ["image-to-video"],
        "resolutions": ["720p"],
        "durations": number_range(5, 10),
        "defaultDuration": 6,
        "aspectRatios": ["16:9", "9:16", "1:1"],
        "references": {"image": 9, "video": 0, "audio": 0},
    },
    "veo-3.1": {
        "mode": "image-to-video",
        "modes": ["image-to-video", "text-to-video"],
        "resolutions": ["720p", "1080p"],
        "durations": [6, 8],
        "defaultDuration": 6,
        "aspectRatios": ["9:16", "16:9"],
        "references": {"image": 9, "video": 0, "audio": 0},
        "referencesByMode": {"text-to-video": NO_MEDIA_LIMITS, "image-to-video": {"image": 9, "video": 0, "audio": 0}},
    },
    "veo-3.1-fast": {
        "mode": "image-to-video",
        "modes": ["image-to-video", "text-to-video"],
        "resolutions": ["720p", "1080p"],
        "durations": [4, 6, 8],
        "defaultDuration": 6,
        "aspectRatios": ["16:9", "9:16"],
        "references": {"image": 9, "video": 0, "audio": 0},
        "referencesByMode": {"text-to-video": NO_MEDIA_LIMITS, "image-to-video": {"image": 9, "video": 0, "audio": 0}},
    },
    "sora-2-pro": {
        "mode": "image-to-video",
        "modes": ["image-to-video", "text-to-video"],
        "resolutions": ["720p", "1080p"],
        "durations": [4, 8, 12],
        "defaultDuration": 8,
        "aspectRatios": ["16:9", "9:16"],
        "references": {"image": 9, "video": 0, "audio": 0},
        "referencesByMode": {"text-to-video": NO_MEDIA_LIMITS, "image-to-video": {"image": 9, "video": 0, "audio": 0}},
    },
    "hailuo-2.3": {
        "mode": "image-to-video",
        "modes": ["image-to-video", "text-to-video"],
        "resolutions": ["1080p"],
        "durations": [10],
        "defaultDuration": 10,
        "aspectRatios": ["16:9", "9:16"],
        "references": {"image": 9, "video": 0, "audio": 0},
        "referencesByMode": {"text-to-video": NO_MEDIA_LIMITS, "image-to-video": {"image": 9, "video": 0, "audio": 0}},
    },
    "gemini-omni-flash-preview": {
        "mode": "edit-video",
        "modes": ["edit-video"],
        "resolutions": [],
        "durations": number_range(3, 10),
        "defaultDuration": 6,
        "aspectRatios": ["16:9", "9:16"],
        "references": {"image": 0, "video": 3, "audio": 0},
    },
}


def model_key(value: str) -> str:
    return "".join(ch for ch in str(value or "").strip().lower() if ch.isalnum())


def canonical_video_model(value: str) -> str:
    original = str(value or "").strip()
    if not original:
        return original
    return ANYCAP_VIDEO_MODEL_ALIASES.get(model_key(original), original)


def is_seedance_model(model: str) -> bool:
    return model_key(model).startswith("seedance2")


def is_kling_model(model: str) -> bool:
    return model_key(model).startswith("kling")


def anycap_catalog() -> dict:
    snapshot = read_json_file(ROOT / "docs" / "anycap" / "catalog-2026-09-08.json", {"models": []})
    cached = read_json_file(RUNTIME_DIR / "anycap-catalog.json", {})
    return cached if isinstance(cached, dict) and cached.get("models") else snapshot


def anycap_model(model: str) -> dict:
    aliases = {"suno-v5-5": "suno-v5.5", "elevenlabs-music": "elevanlabs-music"}
    model_id = aliases.get(model, canonical_video_model(model))
    return next((item for item in anycap_catalog().get("models", []) if item.get("id") == model_id), {})


def anycap_mode_options(parameters: dict, mode: str) -> dict:
    references = {}
    minimums = {}
    for media_type, param in (("image", "images"), ("video", "videos"), ("audio", "audios")):
        definition = parameters.get(param) or {}
        references[media_type] = int(definition.get("maxItems", 1)) if definition else 0
        minimums[media_type] = int(definition.get("minItems", 0))
    if parameters.get("first_frame") and parameters.get("last_frame"):
        references["image"] = minimums["image"] = 2
    return {
        "mode": mode,
        "resolutions": parameters.get("resolution", {}).get("enum", []),
        "durations": parameters.get("duration", {}).get("enum", []),
        "aspectRatios": parameters.get("aspect_ratio", {}).get("enum", []),
        "formats": parameters.get("format", {}).get("enum", []),
        "sampleRates": parameters.get("sample_rate", {}).get("enum", []),
        "supportsGenerateAudio": bool(parameters.get("generate_audio")),
        "supportsAdaptive": "adaptive" in parameters.get("aspect_ratio", {}).get("enum", []),
        "references": references,
        "referenceMinimums": minimums,
    }


def anycap_descriptor(model: str) -> dict:
    entry = anycap_model(model)
    schemas = [item for item in entry.get("schemas", []) if item.get("operation") == "generate"]
    if not schemas:
        return {}
    modes = [item["mode"] for item in schemas]
    mode = "multi-modal-reference" if "multi-modal-reference" in modes else modes[0]
    parameters = {item["mode"]: item["parameters"] for item in schemas}
    mode_options = {key: anycap_mode_options(value, key) for key, value in parameters.items()}
    selected = mode_options[mode]
    durations = selected["durations"]
    return {
        **selected, "capability": entry["capability"], "modes": modes,
        "id": entry["id"], "defaultMode": mode,
        "referenceLimits": selected["references"],
        "referenceLimitsByMode": {key: value["references"] for key, value in mode_options.items()},
        "supportsMultiShot": "multi-shot-video" in modes,
        "parametersByMode": parameters, "modeOptions": mode_options,
        "defaultDuration": 6 if 6 in durations else (durations[0] if durations else None),
        "referencesByMode": {key: value["references"] for key, value in mode_options.items()},
    }


def video_capability(model: str) -> dict:
    descriptor = anycap_descriptor(model)
    if descriptor:
        return descriptor
    return ANYCAP_VIDEO_CAPABILITIES.get(canonical_video_model(model), {
        "mode": "text-to-video",
        "modes": ["text-to-video", "image-to-video"],
        "resolutions": ["720p"],
        "durations": [6, 8, 10],
        "defaultDuration": 6,
        "aspectRatios": ["16:9", "9:16"],
        "references": {"image": 1, "video": 0, "audio": 0},
        "referencesByMode": {"text-to-video": NO_MEDIA_LIMITS, "image-to-video": {"image": 1, "video": 0, "audio": 0}},
    })


def video_reference_limits(model: str, mode: str = "") -> dict:
    capability = video_capability(model)
    modes = capability.get("modes") or []
    resolved_mode = mode if mode in modes else capability.get("mode", "text-to-video")
    by_mode = capability.get("referencesByMode") or {}
    return by_mode.get(resolved_mode) or capability.get("references") or {}


def closest_number(options: list[int], raw_value, fallback: int) -> int:
    if not options:
        return fallback
    try:
        value = int(raw_value)
    except (TypeError, ValueError):
        value = fallback
    return min(options, key=lambda item: abs(item - value))


def route_provider(kind: str, requested: str = "", provider_tool: str = "") -> str:
    provider_tool = provider_tool.strip().lower()
    if provider_tool in PROVIDER_TOOL_LABELS:
        return PROVIDER_TOOL_LABELS[provider_tool]
    requested = requested.strip()
    if requested:
        return requested
    if kind in {"text", "image", "storyboard"}:
        return "Sub2API"
    if kind in {"video", "audio"}:
        return "AnyCap"
    return "Local"


def route_model(kind: str, requested: str) -> str:
    requested = requested or ""
    if requested and not requested.startswith("mock-") and not requested.startswith("local-"):
        if kind == "video":
            return canonical_video_model(requested)
        if kind == "audio":
            return {"suno-v5-5": "suno-v5.5", "elevenlabs-music": "elevanlabs-music"}.get(requested, requested)
        return requested
    if kind == "text":
        return os.environ.get("SUB2API_TEXT_MODEL", "gpt-4o-mini")
    if kind == "image":
        return os.environ.get("SUB2API_IMAGE_MODEL", "gpt-image-2")
    if kind == "video":
        return canonical_video_model(os.environ.get("ANYCAP_VIDEO_MODEL", "seedance-2-fast"))
    if kind == "audio":
        return os.environ.get("ANYCAP_AUDIO_MODEL", "doubao-seed-audio-1-0")
    if kind == "storyboard":
        return os.environ.get("SUB2API_STORYBOARD_MODEL", "gpt-5.5")
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


def run_video_queue(command: str, *args: str, timeout: int = 12):
    if not VIDEO_EDIT_QUEUE_SCRIPT.exists():
        raise RuntimeError("视频剪辑队列脚本不存在")
    result = subprocess.run(
        ["node", str(VIDEO_EDIT_QUEUE_SCRIPT), command, *args],
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
        payload = {"error": stdout or stderr or "视频剪辑队列返回了不可解析的数据"}
    if result.returncode != 0:
        raise RuntimeError(str(payload.get("error") or stderr or "视频剪辑任务不可用"))
    return payload


def video_queue_available() -> tuple[bool, str]:
    try:
        health = run_video_queue("health", timeout=5)
        if health.get("available"):
            return True, ""
        return False, "Redis 已连接，但 video edit worker 未启动"
    except Exception as error:
        return False, str(error)


def local_output_path_from_url(url: str) -> Path | None:
    if not url.startswith("/output/"):
        return None
    relative = unquote(url[len("/output/") :])
    target = (output_dir() / relative).resolve()
    if not is_inside_output(target) or not target.exists() or not target.is_file():
        return None
    return target


def normalize_job_result(job: dict) -> dict:
    clean = copy.deepcopy(job)
    result = clean.get("result")
    if not isinstance(result, dict):
        return clean
    result.pop("path", None)
    candidate_url = str(result.get("fileUrl") or result.get("videoUrl") or result.get("imageUrl") or result.get("audioUrl") or "")
    target = local_output_path_from_url(candidate_url)
    if target:
        media_type = MEDIA_TYPES.get(target.suffix.lower(), "other")
        artifact = artifact_record_for_path(target, artifact_type=media_type)
        result["artifact"] = artifact
        result["fileUrl"] = artifact["previewUrl"]
    return clean


def get_any_job(job_id: str) -> dict:
    runners = [run_video_queue, run_queue] if job_id.startswith("vedit_") else [run_queue, run_video_queue]
    last_error: Exception | None = None
    for runner in runners:
        try:
            return normalize_job_result(runner("get", job_id, timeout=8))
        except Exception as error:
            last_error = error
            if "不存在" not in str(error):
                break
    raise RuntimeError(str(last_error or "任务不存在"))


def list_all_jobs() -> list[dict]:
    jobs: list[dict] = []
    errors = []
    for runner in (run_queue, run_video_queue):
        try:
            result = runner("list", timeout=8)
            if isinstance(result, list):
                jobs.extend(normalize_job_result(item) for item in result if isinstance(item, dict))
        except Exception as error:
            errors.append(str(error))
    if not jobs and len(errors) == 2:
        raise RuntimeError("；".join(errors))
    jobs.sort(key=lambda item: str(item.get("createdAt") or ""), reverse=True)
    return jobs[:160]


def cancel_any_job(job_id: str) -> dict:
    runner = run_video_queue if job_id.startswith("vedit_") else run_queue
    result = runner("cancel", job_id, timeout=8)
    status = str(result.get("status") or "") if isinstance(result, dict) else ""
    if status == "canceled" or (isinstance(result, dict) and result.get("ok") is True and status != "canceling"):
        project_managed_job({"id": job_id, "status": "canceled", "progress": 0, "error": "任务已取消"})
        return {**result, "id": job_id, "status": "canceled"}
    return result


def queue_available() -> tuple[bool, str]:
    try:
        health = run_queue("health", timeout=5)
        if health.get("available"):
            return True, ""
        return False, "Redis 已连接，但 media worker 未启动"
    except Exception as error:
        return False, str(error)


OPTION_ALLOWLIST = {
    "text": {"providerTool", "model", "temperature", "systemPrompt"},
    "image": {
        "mode",
        "providerTool",
        "model",
        "size",
        "resolutionTier",
        "aspectRatio",
        "count",
        "responseFormat",
        "referenceQuality",
        "outputFormat",
        "transparentBackground",
        "quality",
    },
    "video": {
        "providerTool",
        "model",
        "mode",
        "resolution",
        "duration",
        "aspectRatio",
        "generateAudio",
        "fps",
        "format",
        "multiShot",
        "shotCount",
        "operation",
        "audioPolicy",
        "clips",
        "editPlan",
        "planOnly",
        "transition",
        "transitionDuration",
    },
    "audio": {
        "providerTool",
        "model",
        "mode",
        "duration",
        "style",
        "voiceReference",
        "targetVoice",
        "voiceMode",
        "format", "sampleRate", "speechRate", "pitchRate", "loudnessRate",
        "speakerIds", "enableSubtitle", "tags", "title", "lyrics", "makeInstrumental",
        "customMode", "vocalGender", "musicDurationMs",
    },
    "storyboard": {"providerTool", "model", "temperature", "systemPrompt", "promptMode", "viewMode", "shotCount"},
}


def is_inside_output(path: Path) -> bool:
    try:
        path.resolve().relative_to(output_dir().resolve())
        return True
    except ValueError:
        return False


def sanitize_options(kind: str, payload: dict) -> dict:
    raw = payload.get("options") if isinstance(payload.get("options"), dict) else {}
    allowed = OPTION_ALLOWLIST.get(kind, {"model"})
    unknown = sorted(set(raw.keys()) - allowed)
    if unknown:
        raise RuntimeError(f"{kind} 节点不支持这些透传参数：{', '.join(unknown)}")
    clean = {}
    for key, value in raw.items():
        if isinstance(value, (str, int, float, bool)) and value is not None:
            clean[key] = value
        elif kind == "audio" and key == "speakerIds":
            if not isinstance(value, list) or len(value) > 1 or any(not isinstance(item, str) for item in value):
                raise RuntimeError("speakerIds 必须是至多一个音色 ID 的数组")
            clean[key] = [item.strip()[:256] for item in value if item.strip()]
        elif kind == "video" and key in {"clips", "editPlan"}:
            encoded = json.dumps(value, ensure_ascii=False)
            if len(encoded) > 160_000:
                raise RuntimeError(f"视频参数 {key} 超过大小限制")
            if key == "clips" and not isinstance(value, list):
                raise RuntimeError("clips 必须是数组")
            if key == "editPlan" and not isinstance(value, dict):
                raise RuntimeError("editPlan 必须是对象")
            clean[key] = value
    return clean


def sanitize_references(payload: dict) -> list[dict]:
    raw = payload.get("references")
    if not isinstance(raw, list):
        return []
    clean_refs = []
    total_text_length = 0
    for item in raw[:24]:
        if not isinstance(item, dict):
            continue
        ref = {
            "nodeId": str(item.get("nodeId") or ""),
            "title": str(item.get("title") or "Untitled"),
            "kind": str(item.get("kind") or "other"),
            "outputType": str(item.get("outputType") or "other"),
            "source": str(item.get("source") or "canvas"),
        }
        group_id = str(item.get("groupId") or "")
        if group_id:
            ref["groupId"] = group_id
        url = str(item.get("url") or "")
        if url:
            ref["url"] = url
        thumb = str(item.get("thumbnailUrl") or "")
        if thumb:
            ref["thumbnailUrl"] = thumb
        content = str(item.get("content") or "") if ref["outputType"] == "text" else ""
        if content:
            if len(content) > 40_000:
                raise RuntimeError(f"文本引用“{ref['title']}”超过 40,000 字符限制")
            total_text_length += len(content)
            if total_text_length > 120_000:
                raise RuntimeError("文本引用正文总长度超过 120,000 字符限制")
            ref["content"] = content
        raw_path = str(item.get("path") or "")
        if raw_path:
            candidate = Path(raw_path).expanduser().resolve()
            if is_inside_output(candidate):
                ref["path"] = str(candidate)
        if "path" not in ref and url.startswith("/output/"):
            relative = unquote(url[len("/output/") :])
            candidate = (output_dir() / relative).resolve()
            if is_inside_output(candidate):
                ref["path"] = str(candidate)
        clean_refs.append(ref)
    return clean_refs


def normalize_storyboard_options(options: dict) -> dict:
    clean = {**options}
    try:
        raw_shot_count = clean.get("shotCount")
        shot_count = 5 if raw_shot_count is None or raw_shot_count == "" else int(raw_shot_count)
    except (TypeError, ValueError):
        raise RuntimeError("镜头数量必须是 1–20 的整数")
    if shot_count < 1 or shot_count > 20:
        raise RuntimeError("镜头数量必须在 1–20 之间")
    clean["shotCount"] = shot_count
    clean["promptMode"] = clean.get("promptMode") if clean.get("promptMode") in {"image", "video"} else "image"
    clean["viewMode"] = clean.get("viewMode") if clean.get("viewMode") in {"list", "card"} else "list"
    return clean


def normalize_video_options(model: str, options: dict) -> dict:
    capability = video_capability(model)
    modes = capability.get("modes") or []
    requested_mode = str(options.get("mode") or "")
    mode = requested_mode if requested_mode in modes else capability.get("mode", "text-to-video")
    capability = {**capability, **capability.get("modeOptions", {}).get(mode, {})}
    clean = {**options, "mode": mode, "multiShot": mode == "multi-shot-video"}
    durations = capability.get("durations") or []
    if durations:
        clean["duration"] = closest_number(durations, clean.get("duration"), int(capability.get("defaultDuration") or durations[0]))
    resolutions = capability.get("resolutions") or []
    if resolutions:
        resolution = str(clean.get("resolution") or "")
        clean["resolution"] = resolution if resolution in resolutions else resolutions[0]
    else:
        clean.pop("resolution", None)
    ratios = capability.get("aspectRatios") or []
    aspect_ratio = str(clean.get("aspectRatio") or "adaptive")
    clean["aspectRatio"] = aspect_ratio if aspect_ratio in ratios else (ratios[0] if ratios else "adaptive")
    if mode == "multi-shot-video":
        try:
            shot_count = int(clean.get("shotCount") or 3)
        except (TypeError, ValueError):
            shot_count = 3
        clean["shotCount"] = max(1, min(12, shot_count))
    else:
        clean.pop("shotCount", None)
    if capability.get("supportsGenerateAudio"):
        clean["generateAudio"] = clean.get("generateAudio") if isinstance(clean.get("generateAudio"), bool) else True
    else:
        clean.pop("generateAudio", None)
    return clean


def validate_video_references(model: str, references: list[dict], mode: str = "") -> None:
    counts = {"image": 0, "video": 0, "audio": 0}
    for ref in references:
        output_type = ref.get("outputType")
        if output_type in counts:
            counts[output_type] += 1
    limits = video_reference_limits(model, mode)
    minimums = video_capability(model).get("modeOptions", {}).get(mode, {}).get("referenceMinimums", {})
    labels = {"image": "参考图", "video": "参考视频", "audio": "参考音频"}
    for output_type, count in counts.items():
        minimum = int(minimums.get(output_type) or 0)
        if count < minimum:
            raise RuntimeError(f"{model} 当前模式需要至少 {minimum} 个{labels[output_type]}")
        limit = int(limits.get(output_type) or 0)
        if count > limit:
            if limit <= 0:
                raise RuntimeError(f"{model} 当前模式暂不支持{labels[output_type]}")
            raise RuntimeError(f"{model} 最多支持 {limit} 个{labels[output_type]}，当前是 {count} 个")


def normalize_anycap_audio_options(model: str, options: dict, references: list[dict], prompt: str) -> dict:
    descriptor = anycap_descriptor(model)
    if not descriptor or descriptor.get("capability") not in {"audio", "music"}:
        raise RuntimeError(f"音频模型 {model} 尚未同步，请刷新 AnyCap 模型列表")
    mode = options.get("mode") if options.get("mode") in descriptor["modes"] else descriptor["mode"]
    parameters = descriptor["parametersByMode"][mode]
    limits = descriptor["modeOptions"][mode]
    for media_type, maximum in limits["references"].items():
        count = len({ref.get("path") or ref.get("url") or ref.get("nodeId") for ref in references if ref.get("outputType") == media_type})
        minimum = limits["referenceMinimums"][media_type]
        if count < minimum or count > maximum:
            raise RuntimeError(f"{model} / {mode} 需要 {minimum}–{maximum} 个 {media_type} 参考，当前 {count} 个")
    max_length = parameters.get("prompt", {}).get("maxLength")
    if max_length and len(prompt) > max_length:
        raise RuntimeError(f"{model} 提示词最多 {max_length} 个字符")
    return {**options, "mode": mode}


def create_job(payload: dict):
    kind = str(payload.get("kind") or "text")
    options = sanitize_options(kind, payload)
    references = sanitize_references(payload)
    operation = str(options.get("operation") or "generate")
    use_video_queue = kind == "video" and operation in {"ai-edit", "concat", "creative-edit"}
    available, reason = video_queue_available() if use_video_queue else queue_available()
    if not available:
        raise RuntimeError(reason)
    requested_model = str(options.get("model") or payload.get("model") or "")
    provider_tool = str(options.get("providerTool") or "")
    model = route_model(kind, requested_model)
    if kind == "audio" and provider_tool in {"", "anycap"}:
        options = normalize_anycap_audio_options(model, options, references, str(payload.get("prompt") or ""))
    if kind == "video":
        if use_video_queue:
            video_references = [reference for reference in references if reference.get("outputType") == "video"]
            if len(video_references) != len(references):
                raise RuntimeError("视频剪辑只支持引用视频素材")
            minimum, maximum = (1, 3) if operation == "creative-edit" else (2, 20)
            if len(video_references) < minimum or len(video_references) > maximum:
                raise RuntimeError(f"{operation} 需要 {minimum}–{maximum} 个视频素材")
            options["operation"] = operation
            options["transition"] = options.get("transition") if options.get("transition") in {"cut", "crossfade"} else "cut"
            options["audioPolicy"] = (
                options.get("audioPolicy")
                if options.get("audioPolicy") in {"keep", "preserve", "mute", "normalize"}
                else "keep"
            )
            if operation == "creative-edit":
                model = canonical_video_model(requested_model or "gemini-omni-flash-preview")
            elif not requested_model:
                model = "selfcanvas-smart-edit"
        else:
            options = normalize_video_options(model, options)
            validate_video_references(model, references, str(options.get("mode") or ""))
    if kind == "storyboard":
        options = normalize_storyboard_options(options)
        for reference in references:
            if reference.get("outputType") == "text" and not str(reference.get("content") or "").strip():
                raise RuntimeError(f"引用的文本节点“{reference.get('title') or '未命名'}”尚未生成正文")
    created_at = now_iso()
    job = {
        "id": f"{'vedit' if use_video_queue else 'job'}_{uuid.uuid4().hex[:14]}",
        "nodeId": str(payload.get("nodeId") or ""),
        "targetNodeId": str(payload.get("targetNodeId") or payload.get("nodeId") or ""),
        "kind": kind,
        "title": str(payload.get("title") or kind),
        "provider": "SelfCanvas AI Edit" if use_video_queue else route_provider(kind, str(payload.get("provider") or ""), provider_tool),
        "model": model,
        "status": "queued",
        "progress": 0,
        "prompt": str(payload.get("prompt") or ""),
        "inputs": payload.get("inputs") if isinstance(payload.get("inputs"), list) else [],
        "references": references,
        "options": options,
        "createdAt": created_at,
        "updatedAt": created_at,
    }
    RUNTIME_DIR.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile("w", suffix=".json", dir=RUNTIME_DIR, delete=False, encoding="utf-8") as temp:
        json.dump(job, temp, ensure_ascii=False)
        temp_path = temp.name
    try:
        return (run_video_queue if use_video_queue else run_queue)("enqueue", temp_path, timeout=12)
    finally:
        Path(temp_path).unlink(missing_ok=True)


def node_generation_payload(node: dict) -> dict:
    data = node.get("data") if isinstance(node.get("data"), dict) else {}
    return {
        "nodeId": str(node.get("id") or ""),
        "targetNodeId": str(node.get("id") or ""),
        "kind": str(data.get("kind") or "text"),
        "title": str(data.get("title") or data.get("kind") or "节点"),
        "prompt": str(data.get("prompt") or ""),
        "provider": str(data.get("provider") or ""),
        "model": str(data.get("model") or ""),
        "inputs": data.get("inputs") if isinstance(data.get("inputs"), list) else [],
        "references": data.get("references") if isinstance(data.get("references"), list) else [],
        "options": data.get("providerOptions") if isinstance(data.get("providerOptions"), dict) else {},
    }


def track_managed_job(job: dict, canvas_id: str, node_id: str) -> None:
    job_id = str(job.get("id") or "")
    if not job_id:
        return
    with MANAGED_JOBS_LOCK:
        jobs = read_json_file(MANAGED_JOBS_PATH, {})
        if not isinstance(jobs, dict):
            jobs = {}
        jobs[job_id] = {
            "jobId": job_id,
            "canvasId": canvas_id,
            "nodeId": node_id,
            "createdAt": now_iso(),
        }
        write_json_atomic(MANAGED_JOBS_PATH, jobs)


def remove_managed_job(job_id: str) -> None:
    with MANAGED_JOBS_LOCK:
        jobs = read_json_file(MANAGED_JOBS_PATH, {})
        if not isinstance(jobs, dict) or job_id not in jobs:
            return
        jobs.pop(job_id, None)
        write_json_atomic(MANAGED_JOBS_PATH, jobs)


def project_managed_job(job: dict) -> bool:
    job_id = str(job.get("id") or "")
    if not job_id or job.get("status") not in {"success", "error", "canceled"}:
        return False
    with MANAGED_JOBS_LOCK:
        jobs = read_json_file(MANAGED_JOBS_PATH, {})
        tracked = jobs.get(job_id) if isinstance(jobs, dict) else None
    if not isinstance(tracked, dict):
        return False
    updated_record = None
    with PROJECT_STATE_LOCK:
        current = read_project_record_unlocked()
        project = copy.deepcopy(current.get("project"))
        if not isinstance(project, dict):
            remove_managed_job(job_id)
            return False
        try:
            _, canvas = require_project_canvas({"project": project}, str(tracked.get("canvasId") or ""))
            node = find_canvas_node(canvas, str(tracked.get("nodeId") or ""))
        except UploadError:
            remove_managed_job(job_id)
            return False
        data = node.get("data") if isinstance(node.get("data"), dict) else {}
        if str(data.get("lastJobId") or "") != job_id:
            remove_managed_job(job_id)
            return False
        if job.get("status") == "success":
            data.update({"status": "success", "progress": 100, "outputs": job.get("result") or {}, "error": ""})
        else:
            data.update(
                {
                    "status": "error",
                    "progress": 0,
                    "error": str(job.get("error") or ("任务已取消" if job.get("status") == "canceled" else "任务失败")),
                }
            )
        timestamp = now_iso()
        canvas["updatedAt"] = timestamp
        project["updatedAt"] = timestamp
        updated_record = {
            "schemaVersion": 1,
            "revision": int(current.get("revision") or 0) + 1,
            "savedAt": timestamp,
            "project": validate_project(project),
        }
        write_json_atomic(PROJECT_STATE_PATH, updated_record)
    remove_managed_job(job_id)
    publish_project_event(
        updated_record,
        "job.completed" if job.get("status") == "success" else "job.failed",
        {"jobId": job_id, "canvasId": tracked.get("canvasId"), "nodeId": tracked.get("nodeId")},
    )
    return True


def managed_job_projector_loop() -> None:
    cursor = 0
    while True:
        try:
            with MANAGED_JOBS_LOCK:
                jobs = read_json_file(MANAGED_JOBS_PATH, {})
                job_items = list(jobs.items()) if isinstance(jobs, dict) else []
            if job_items:
                start = cursor % len(job_items)
                batch_size = min(100, len(job_items))
                batch = [job_items[(start + index) % len(job_items)] for index in range(batch_size)]
                cursor = (start + batch_size) % len(job_items)
            else:
                batch = []
                cursor = 0
            for job_id, tracked in batch:
                try:
                    job = get_any_job(str(job_id))
                    project_managed_job(job)
                except Exception as error:
                    if "不存在" not in str(error) or not isinstance(tracked, dict):
                        continue
                    try:
                        created_at = datetime.fromisoformat(str(tracked.get("createdAt") or "").replace("Z", "+00:00"))
                        age_seconds = max(0, (datetime.now(timezone.utc) - created_at.astimezone(timezone.utc)).total_seconds())
                    except (TypeError, ValueError):
                        age_seconds = float("inf")
                    grace = bounded_env_int("SELF_CANVAS_MISSING_JOB_GRACE_SECONDS", 600, 60, 86_400)
                    if age_seconds >= grace:
                        project_managed_job(
                            {
                                "id": str(job_id),
                                "status": "error",
                                "progress": 0,
                                "error": "后台任务记录已失效，请重新生成",
                            }
                        )
                    continue
        except Exception as error:
            print(f"[server] managed job projector: {error}")
        time.sleep(1.5)


def start_saved_node_job(canvas_id: str, node_id: str, body: dict) -> dict:
    request_id = require_request_id(body)
    key = f"run:{canvas_id}:{node_id}:{request_id}"
    with IDEMPOTENCY_LOCK:
        cached = idempotency_lookup(key)
        if cached:
            return cached
        with PROJECT_STATE_LOCK:
            current = read_project_record_unlocked()
            try:
                base_revision = int(body.get("baseRevision"))
            except (TypeError, ValueError) as error:
                raise UploadError(400, "baseRevision 无效") from error
            if base_revision != int(current.get("revision") or 0):
                raise ProjectRevisionConflict(current)
            project = copy.deepcopy(current.get("project"))
            if not isinstance(project, dict):
                raise UploadError(404, "画布项目不存在")
            _, canvas = require_project_canvas({"project": project}, canvas_id)
            node = find_canvas_node(canvas, node_id)
            job = create_job(node_generation_payload(node))
            data = node.setdefault("data", {})
            data.update(
                {
                    "status": "running",
                    "progress": max(3, int(job.get("progress") or 0)),
                    "lastJobId": str(job.get("id") or ""),
                    "outputs": {},
                    "error": "",
                }
            )
            timestamp = now_iso()
            canvas["updatedAt"] = timestamp
            project["updatedAt"] = timestamp
            record = {
                "schemaVersion": 1,
                "revision": int(current.get("revision") or 0) + 1,
                "savedAt": timestamp,
                "project": validate_project(project),
            }
            write_json_atomic(PROJECT_STATE_PATH, record)
        track_managed_job(job, canvas_id, node_id)
        result = {
            "projectId": str(project.get("id") or ""),
            "canvasId": canvas_id,
            "nodeId": node_id,
            "revision": int(record["revision"]),
            "requestId": request_id,
            "job": normalize_job_result(job),
        }
        idempotency_remember(key, result)
    publish_project_event(record, "node.run", {"canvasId": canvas_id, "nodeId": node_id, "jobId": job.get("id")})
    return result


def canvas_node_video_reference(node: dict) -> dict:
    data = node.get("data") if isinstance(node.get("data"), dict) else {}
    outputs = data.get("outputs") if isinstance(data.get("outputs"), dict) else {}
    imported = data.get("importedMedia") if isinstance(data.get("importedMedia"), dict) else {}
    url = str(outputs.get("videoUrl") or outputs.get("fileUrl") or imported.get("url") or "")
    if not url or not local_output_path_from_url(url):
        raise UploadError(400, f"节点“{data.get('title') or node.get('id')}”没有已落盘的视频")
    return {
        "nodeId": str(node.get("id") or ""),
        "title": str(data.get("title") or "视频"),
        "kind": "video",
        "outputType": "video",
        "source": "canvas",
        "url": url,
        "thumbnailUrl": url,
    }


def create_video_edit_job(canvas_id: str, body: dict) -> dict:
    request_id = require_request_id(body)
    key = f"video-edit:{canvas_id}:{request_id}"
    with IDEMPOTENCY_LOCK:
        cached = idempotency_lookup(key)
        if cached:
            return cached
        mode_map = {"ai_edit": "ai-edit", "merge": "concat", "creative": "creative-edit"}
        operation = mode_map.get(str(body.get("mode") or ""))
        if not operation:
            raise UploadError(400, "视频剪辑模式无效")
        source_ids = [str(value) for value in body.get("sourceNodeIds", []) if str(value)] if isinstance(body.get("sourceNodeIds"), list) else []
        if len(set(source_ids)) != len(source_ids):
            raise UploadError(400, "sourceNodeIds 不可重复")
        minimum, maximum = (1, 3) if operation == "creative-edit" else (2, 20)
        if len(source_ids) < minimum or len(source_ids) > maximum:
            raise UploadError(400, f"当前模式需要 {minimum}–{maximum} 段视频")
        with PROJECT_STATE_LOCK:
            current = read_project_record_unlocked()
            try:
                base_revision = int(body.get("baseRevision"))
            except (TypeError, ValueError) as error:
                raise UploadError(400, "baseRevision 无效") from error
            if base_revision != int(current.get("revision") or 0):
                raise ProjectRevisionConflict(current)
            project = copy.deepcopy(current.get("project"))
            if not isinstance(project, dict):
                raise UploadError(404, "画布项目不存在")
            _, canvas = require_project_canvas({"project": project}, canvas_id)
            sources = [find_canvas_node(canvas, node_id) for node_id in source_ids]
            references = [canvas_node_video_reference(node) for node in sources]
            target_id = str(body.get("targetNodeId") or "")
            if target_id:
                target_node = find_canvas_node(canvas, target_id)
                if str(target_node.get("data", {}).get("kind") or "") != "video":
                    raise UploadError(400, "目标节点必须是视频节点")
            else:
                max_x = max((float(node.get("position", {}).get("x") or 0) for node in sources), default=120)
                max_y = max((float(node.get("position", {}).get("y") or 0) for node in sources), default=120)
                target_node = build_canvas_node(
                    {
                        "kind": "video",
                        "title": "视频",
                        "prompt": str(body.get("prompt") or ""),
                        "position": {"x": max_x + 380, "y": max_y},
                        "provider": "SelfCanvas AI Edit",
                        "model": "gemini-omni-flash-preview" if operation == "creative-edit" else "selfcanvas-smart-edit",
                    }
                )
                canvas.setdefault("nodes", []).append(target_node)
                target_id = str(target_node.get("id") or "")
            data = target_node.setdefault("data", {})
            output = body.get("output") if isinstance(body.get("output"), dict) else {}
            options = {
                "providerTool": "anycap" if operation == "creative-edit" else "local-edit",
                "model": "gemini-omni-flash-preview" if operation == "creative-edit" else "selfcanvas-smart-edit",
                "operation": operation,
                "transition": str(body.get("transition") or "cut"),
                "audioPolicy": "keep" if str(body.get("audioPolicy") or "preserve") == "preserve" else str(body.get("audioPolicy")),
                "format": "mp4",
            }
            for key_name in ("resolution", "aspectRatio", "fps", "format"):
                value = output.get(key_name)
                if isinstance(value, (str, int, float, bool)):
                    options[key_name] = value
            data.update(
                {
                    "kind": "video",
                    "title": str(data.get("title") or "视频"),
                    "prompt": str(body.get("prompt") or data.get("prompt") or "")[:20_000],
                    "provider": "SelfCanvas AI Edit",
                    "model": options["model"],
                    "references": references,
                    "providerOptions": options,
                }
            )
            job = create_job(node_generation_payload(target_node))
            data.update(
                {
                    "status": "running",
                    "progress": max(3, int(job.get("progress") or 0)),
                    "lastJobId": str(job.get("id") or ""),
                    "outputs": {},
                    "error": "",
                }
            )
            timestamp = now_iso()
            canvas["updatedAt"] = timestamp
            project["updatedAt"] = timestamp
            record = {
                "schemaVersion": 1,
                "revision": int(current.get("revision") or 0) + 1,
                "savedAt": timestamp,
                "project": validate_project(project),
            }
            write_json_atomic(PROJECT_STATE_PATH, record)
        track_managed_job(job, canvas_id, target_id)
        result = {
            "projectId": str(project.get("id") or ""),
            "canvasId": canvas_id,
            "nodeId": target_id,
            "revision": int(record["revision"]),
            "requestId": request_id,
            "job": normalize_job_result(job),
        }
        idempotency_remember(key, result)
    publish_project_event(record, "video-edit.created", {"canvasId": canvas_id, "nodeId": target_id, "jobId": job.get("id")})
    return result


def canvas_artifact_records(canvas: dict, node_id: str = "") -> list[dict]:
    nodes = canvas.get("nodes") if isinstance(canvas.get("nodes"), list) else []
    if node_id:
        nodes = [find_canvas_node(canvas, node_id)]
    artifacts: list[dict] = []
    seen: set[str] = set()
    for node in nodes:
        if not isinstance(node, dict):
            continue
        data = node.get("data") if isinstance(node.get("data"), dict) else {}
        outputs = data.get("outputs") if isinstance(data.get("outputs"), dict) else {}
        imported = data.get("importedMedia") if isinstance(data.get("importedMedia"), dict) else {}
        output_artifact = outputs.get("artifact") if isinstance(outputs.get("artifact"), dict) else {}
        imported_artifact = imported.get("artifact") if isinstance(imported.get("artifact"), dict) else {}
        artifact_ids = [output_artifact.get("id"), imported_artifact.get("id"), imported.get("id")]
        urls = [
            outputs.get("fileUrl"),
            outputs.get("videoUrl"),
            outputs.get("imageUrl"),
            outputs.get("audioUrl"),
            output_artifact.get("previewUrl"),
            imported.get("url"),
            imported.get("previewUrl"),
            imported_artifact.get("previewUrl"),
        ]
        targets: list[Path] = []
        for artifact_id in artifact_ids:
            candidate = str(artifact_id or "").strip()
            if not candidate or len(candidate) > 4096:
                continue
            try:
                targets.append(output_target_from_artifact_id(candidate))
            except UploadError:
                continue
        for raw_url in urls:
            target = local_output_path_from_url(str(raw_url or ""))
            if target:
                targets.append(target)
        for target in targets:
            artifact = artifact_record_for_path(target)
            artifact_id = str(artifact.get("id") or "")
            if not artifact_id or artifact_id in seen:
                continue
            seen.add(artifact_id)
            artifacts.append({**artifact, "artifactId": artifact["id"], "nodeId": str(node.get("id") or "")})
    return artifacts


def list_canvas_artifacts_v2(canvas_id: str, query: dict[str, list[str]]) -> dict:
    record = read_project_record()
    _, canvas = require_project_canvas(record, canvas_id)
    node_id = str((query.get("nodeId") or [""])[0] or "")
    types = {str(value) for value in query.get("type", []) if str(value)}
    artifacts = [
        artifact
        for artifact in canvas_artifact_records(canvas, node_id)
        if not types or str(artifact.get("type")) in types
    ]
    artifacts.sort(key=lambda item: str(item.get("createdAt") or ""), reverse=True)
    cursor, limit = pagination_values(query)
    page = artifacts[cursor : cursor + limit]
    next_cursor = cursor + limit if cursor + limit < len(artifacts) else None
    return {
        "canvasId": canvas_id,
        "revision": int(record.get("revision") or 0),
        "artifacts": page,
        "nextCursor": str(next_cursor) if next_cursor is not None else None,
    }


def prepare_download_v2(body: dict) -> dict:
    request_id = require_request_id(body)
    canvas_id = str(body.get("canvasId") or "")
    _, canvas = require_project_canvas(read_project_record(), canvas_id)
    artifact_ids = body.get("artifactIds") if isinstance(body.get("artifactIds"), list) else []
    artifact_ids = list(dict.fromkeys(str(value) for value in artifact_ids if str(value)))
    if not artifact_ids or len(artifact_ids) > 100:
        raise UploadError(400, "artifactIds 必须包含 1–100 个文件")
    allowed_ids = {str(item.get("id") or "") for item in canvas_artifact_records(canvas)}
    if any(artifact_id not in allowed_ids for artifact_id in artifact_ids):
        raise UploadError(403, "只能下载该画布中已落盘的产物")
    key = f"download:{canvas_id}:{request_id}"
    with IDEMPOTENCY_LOCK:
        cached = idempotency_lookup(key)
        if cached:
            return cached
        if len(artifact_ids) == 1:
            artifact = artifact_record_for_path(output_target_from_artifact_id(artifact_ids[0]))
            result = {"requestId": request_id, "status": "ready", "artifact": artifact, "downloadUrl": artifact["downloadUrl"]}
        else:
            result = {
                "requestId": request_id,
                **create_export_job({"fileIds": artifact_ids, "archiveName": body.get("archiveName")}),
            }
        idempotency_remember(key, result)
        return result


def get_job_v2(job_id: str) -> dict:
    if job_id.startswith("export_"):
        return get_export_job(job_id)
    job = get_any_job(job_id)
    project_managed_job(job)
    return job


def configured_allowed_origins() -> set[str]:
    configured = os.environ.get("SELF_CANVAS_ALLOWED_ORIGINS", "").strip()
    return {item.strip().rstrip("/") for item in configured.split(",") if item.strip()}


def browser_request_origin_allowed(handler: BaseHTTPRequestHandler) -> bool:
    fetch_site = str(handler.headers.get("Sec-Fetch-Site") or "").lower()
    if fetch_site and fetch_site not in {"same-origin", "same-site", "none"}:
        return False
    origin = str(handler.headers.get("Origin") or "").strip().rstrip("/")
    if not origin:
        return True
    if origin in configured_allowed_origins():
        return True
    try:
        origin_host = urlparse(origin).netloc.lower()
    except ValueError:
        return False
    request_hosts = {
        str(handler.headers.get("Host") or "").strip().lower(),
        str(handler.headers.get("X-Forwarded-Host") or "").strip().lower(),
    }
    return bool(origin_host and origin_host in request_hosts)


def prune_browser_sessions(timestamp: float | None = None) -> None:
    current = timestamp if timestamp is not None else time.time()
    expired = [key for key, value in BROWSER_SESSIONS.items() if float(value.get("expiresAt") or 0) <= current]
    for key in expired:
        BROWSER_SESSIONS.pop(key, None)
    if len(BROWSER_SESSIONS) > 512:
        ordered = sorted(BROWSER_SESSIONS.items(), key=lambda item: float(item[1].get("expiresAt") or 0))
        for key, _ in ordered[: len(BROWSER_SESSIONS) - 512]:
            BROWSER_SESSIONS.pop(key, None)


def browser_cookie_session_id(handler: BaseHTTPRequestHandler) -> str:
    raw_cookie = str(handler.headers.get("Cookie") or "")
    if not raw_cookie:
        return ""
    try:
        cookies = SimpleCookie()
        cookies.load(raw_cookie)
        morsel = cookies.get(BROWSER_SESSION_COOKIE)
        return morsel.value if morsel else ""
    except Exception:
        return ""


def create_browser_session(handler: BaseHTTPRequestHandler) -> None:
    if not browser_request_origin_allowed(handler):
        raise UploadError(403, "浏览器来源不受信任")
    expires_at = time.time() + BROWSER_SESSION_TTL_SECONDS
    with BROWSER_SESSIONS_LOCK:
        prune_browser_sessions()
        session_id = browser_cookie_session_id(handler)
        session = BROWSER_SESSIONS.get(session_id) if session_id else None
        if session:
            csrf_token = str(session.get("csrfToken") or "")
            session["expiresAt"] = expires_at
        else:
            session_id = secrets.token_urlsafe(32)
            csrf_token = secrets.token_urlsafe(32)
            BROWSER_SESSIONS[session_id] = {"csrfToken": csrf_token, "expiresAt": expires_at}
    payload = {
        "csrfToken": csrf_token,
        "expiresAt": datetime.fromtimestamp(expires_at, timezone.utc).isoformat(),
    }
    body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    cookie = (
        f"{BROWSER_SESSION_COOKIE}={session_id}; HttpOnly; SameSite=Strict; "
        f"Path=/; Max-Age={BROWSER_SESSION_TTL_SECONDS}"
    )
    forwarded_proto = str(handler.headers.get("X-Forwarded-Proto") or "").lower()
    if forwarded_proto == "https":
        cookie += "; Secure"
    handler.send_response(200)
    handler.send_header("Content-Type", "application/json; charset=utf-8")
    handler.send_header("Content-Length", str(len(body)))
    handler.send_header("Cache-Control", "no-store")
    handler.send_header("Set-Cookie", cookie)
    handler.end_headers()
    handler.wfile.write(body)


def browser_session_valid(handler: BaseHTTPRequestHandler) -> bool:
    if not browser_request_origin_allowed(handler):
        return False
    csrf_token = str(handler.headers.get("X-SelfCanvas-CSRF") or "").strip()
    if not csrf_token:
        return False
    session_id = browser_cookie_session_id(handler)
    if not session_id:
        return False
    with BROWSER_SESSIONS_LOCK:
        prune_browser_sessions()
        session = BROWSER_SESSIONS.get(session_id)
        if not session:
            return False
        expected_csrf = str(session.get("csrfToken") or "")
        if not expected_csrf or not hmac.compare_digest(csrf_token, expected_csrf):
            return False
        session["expiresAt"] = time.time() + BROWSER_SESSION_TTL_SECONDS
    return True


def static_api_token_valid(handler: BaseHTTPRequestHandler) -> bool:
    expected = os.environ.get("SELF_CANVAS_API_TOKEN", "").strip()
    authorization = str(handler.headers.get("Authorization") or "")
    token = authorization[7:].strip() if authorization.lower().startswith("bearer ") else ""
    return bool(expected and token and hmac.compare_digest(token, expected))


def mobile_access_token_valid(handler: BaseHTTPRequestHandler) -> bool:
    authorization = str(handler.headers.get("Authorization") or "")
    token = authorization[7:].strip() if authorization.lower().startswith("bearer ") else ""
    if not token.startswith("scm1."):
        return False
    try:
        payload = mobile_token_payload(token, "access")
    except UploadError:
        return False
    session_id = str(payload.get("sid") or "")
    username = str(payload.get("sub") or "")
    with MOBILE_SESSIONS_LOCK:
        sessions = read_mobile_sessions_unlocked()
        dirty = prune_mobile_sessions(sessions)
        session = sessions.get(session_id)
        if dirty:
            write_mobile_sessions_unlocked(sessions)
    return bool(isinstance(session, dict) and hmac.compare_digest(str(session.get("username") or ""), username))


def mobile_current_user(handler: BaseHTTPRequestHandler) -> dict:
    authorization = str(handler.headers.get("Authorization") or "")
    token = authorization[7:].strip() if authorization.lower().startswith("bearer ") else ""
    payload = mobile_token_payload(token, "access")
    if not mobile_access_token_valid(handler):
        raise UploadError(401, "登录已失效，请重新登录")
    username = str(payload["sub"])
    return {
        "id": hashlib.sha256(username.encode("utf-8")).hexdigest()[:16],
        "username": username,
        "roles": ["creator"],
    }


def bearer_api_token_valid(handler: BaseHTTPRequestHandler) -> bool:
    return static_api_token_valid(handler) or mobile_access_token_valid(handler)


def require_v2_api_token(handler: BaseHTTPRequestHandler) -> None:
    if bearer_api_token_valid(handler) or browser_session_valid(handler):
        return
    raise UploadError(401, "未授权访问 SelfCanvas API")


def require_write_access(handler: BaseHTTPRequestHandler) -> None:
    if bearer_api_token_valid(handler) or browser_session_valid(handler):
        return
    raise UploadError(401, "未授权写入 SelfCanvas")


MEDIA_TYPES = {
    ".png": "image",
    ".jpg": "image",
    ".jpeg": "image",
    ".webp": "image",
    ".gif": "image",
    ".avif": "image",
    ".mp4": "video",
    ".webm": "video",
    ".mov": "video",
    ".m4v": "video",
    ".mp3": "audio",
    ".wav": "audio",
    ".m4a": "audio",
    ".aac": "audio",
    ".ogg": "audio",
    ".flac": "audio",
    ".zip": "other",
}

UPLOAD_CHUNK_SIZE = 1024 * 1024


class UploadError(RuntimeError):
    def __init__(self, status: int, message: str):
        super().__init__(message)
        self.status = status


def max_upload_bytes() -> int:
    raw = os.environ.get("SELF_CANVAS_MAX_UPLOAD_MB", "1024")
    try:
        megabytes = max(1, int(raw))
    except ValueError:
        megabytes = 1024
    return megabytes * 1024 * 1024


def safe_upload_name(encoded_name: str) -> tuple[str, str]:
    original = Path(unquote(encoded_name or "").replace("\\", "/")).name.strip()
    if not original:
        raise UploadError(400, "缺少有效文件名")
    display_name = re.sub(r"[\x00-\x1f\x7f]+", "_", original).strip(" .")
    suffix = Path(display_name).suffix.lower()
    if suffix not in MEDIA_TYPES:
        raise UploadError(415, f"不支持的媒体格式：{suffix or '无扩展名'}")
    stem = Path(display_name).stem.strip(" .") or "media"
    while len(f"{stem}{suffix}".encode("utf-8")) > 220 and stem:
        stem = stem[:-1]
    storage_name = f"{stem or 'media'}{suffix}"
    return display_name, storage_name


def output_display_title(path: Path) -> str:
    stem = path.stem
    if "--" not in stem:
        return stem
    prefix, display = stem.split("--", 1)
    if len(prefix) == 32 and all(char in "0123456789abcdef" for char in prefix.lower()):
        return display
    return stem


def artifact_record_for_path(path: Path, *, artifact_type: str | None = None, title: str | None = None) -> dict:
    target = path.resolve()
    if not is_inside_output(target) or not target.exists() or not target.is_file():
        raise UploadError(404, "文件不存在")
    relative = target.relative_to(output_dir().resolve()).as_posix()
    media_type = artifact_type or MEDIA_TYPES.get(target.suffix.lower(), "other")
    mime_type = mimetypes.guess_type(str(target))[0] or "application/octet-stream"
    artifact_id = artifact_id_for_relative(relative)
    preview_url = f"/output/{quote(relative)}"
    download_url = f"/api/files/download/{quote(artifact_id)}"
    return {
        "id": artifact_id,
        "name": target.name,
        "title": title or output_display_title(target),
        "type": media_type,
        "mimeType": mime_type,
        "size": target.stat().st_size,
        "previewUrl": preview_url,
        "downloadUrl": download_url,
        "url": preview_url,
        "createdAt": datetime.fromtimestamp(target.stat().st_mtime, timezone.utc).isoformat(),
    }


def receive_media_upload(handler: BaseHTTPRequestHandler) -> dict:
    try:
        content_length = int(handler.headers.get("Content-Length") or 0)
    except ValueError as error:
        raise UploadError(400, "无效的文件大小") from error
    if content_length <= 0:
        raise UploadError(400, "文件内容为空")
    if content_length > max_upload_bytes():
        handler.close_connection = True
        max_mb = max_upload_bytes() // (1024 * 1024)
        raise UploadError(413, f"单个文件不能超过 {max_mb} MB")

    original_name, safe_name = safe_upload_name(handler.headers.get("X-File-Name") or "")
    media_type = MEDIA_TYPES[Path(safe_name).suffix.lower()]
    upload_root = output_dir() / "uploads" / datetime.now(timezone.utc).strftime("%Y-%m-%d")
    token = uuid.uuid4().hex
    upload_dir = upload_root / token
    upload_dir.mkdir(parents=True, exist_ok=False)
    target = upload_dir / safe_name
    temporary = upload_dir / ".upload.part"
    remaining = content_length

    try:
        with temporary.open("wb") as output:
            while remaining > 0:
                chunk = handler.rfile.read(min(UPLOAD_CHUNK_SIZE, remaining))
                if not chunk:
                    raise UploadError(400, "上传中断，文件内容不完整")
                output.write(chunk)
                remaining -= len(chunk)
        os.replace(temporary, target)
    except Exception:
        temporary.unlink(missing_ok=True)
        try:
            upload_dir.rmdir()
        except OSError:
            pass
        raise

    rel = target.relative_to(output_dir()).as_posix()
    requested_mime = (handler.headers.get("Content-Type") or "").split(";", 1)[0].strip()
    guessed_mime = mimetypes.guess_type(str(target))[0] or "application/octet-stream"
    mime_type = requested_mime if requested_mime.startswith(f"{media_type}/") else guessed_mime
    artifact = artifact_record_for_path(target, artifact_type=media_type, title=original_name)
    return {
        **artifact,
        "name": original_name,
        "type": media_type,
        "mimeType": mime_type,
        "artifact": artifact,
    }


def list_output_files():
    base = output_dir()
    if not base.exists():
        return []
    files = []
    for path in base.rglob("*"):
        if not path.is_file():
            continue
        relative = path.relative_to(base)
        if any(part.startswith(".") for part in relative.parts):
            continue
        media_type = MEDIA_TYPES.get(path.suffix.lower(), "other")
        if media_type == "other":
            continue
        files.append(artifact_record_for_path(path, artifact_type=media_type))
    return sorted(files, key=lambda item: item["createdAt"], reverse=True)


def export_job_payload(job: dict) -> dict:
    return copy.deepcopy(job)


def export_size_limit_bytes() -> int:
    return bounded_env_int("SELF_CANVAS_MAX_EXPORT_GB", 8, 1, 100) * 1024 * 1024 * 1024


def ensure_export_capacity(targets: list[Path]) -> int:
    total_bytes = sum(target.stat().st_size for target in targets)
    maximum = export_size_limit_bytes()
    if total_bytes > maximum:
        raise UploadError(413, f"打包源文件总大小不能超过 {maximum // (1024 * 1024 * 1024)} GB")
    disk = shutil.disk_usage(output_dir())
    reserve = bounded_env_int("SELF_CANVAS_MIN_FREE_GB", 1, 0, 100) * 1024 * 1024 * 1024
    overhead = max(64 * 1024 * 1024, total_bytes // 20)
    if disk.free < total_bytes + overhead + reserve:
        raise UploadError(507, "输出磁盘空间不足，无法安全创建 ZIP")
    return total_bytes


def run_export_job(export_id: str, artifact_ids: list[str], archive_name: str) -> None:
    with EXPORT_JOBS_LOCK:
        if export_id not in EXPORT_JOBS:
            return
        EXPORT_JOBS[export_id].update({"status": "running", "progress": 5, "updatedAt": now_iso()})
    try:
        targets = [output_target_from_artifact_id(artifact_id) for artifact_id in artifact_ids]
        ensure_export_capacity(targets)
        export_dir = output_dir() / "exports" / export_id
        export_dir.mkdir(parents=True, exist_ok=True)
        target = export_dir / archive_name
        temporary = target.with_suffix(".zip.part")
        used_names: dict[str, int] = {}
        try:
            # Generated images/video/audio are already compressed. Storing them
            # avoids wasting CPU and makes required disk space predictable.
            with zipfile.ZipFile(temporary, "w", compression=zipfile.ZIP_STORED) as archive:
                for index, source in enumerate(targets):
                    base_name = source.name
                    seen = used_names.get(base_name, 0)
                    used_names[base_name] = seen + 1
                    archive_name = base_name if seen == 0 else f"{source.stem}-{seen + 1}{source.suffix}"
                    archive.write(source, arcname=archive_name)
                    with EXPORT_JOBS_LOCK:
                        if export_id in EXPORT_JOBS:
                            EXPORT_JOBS[export_id]["progress"] = min(94, 10 + round(((index + 1) / len(targets)) * 84))
            os.replace(temporary, target)
        finally:
            temporary.unlink(missing_ok=True)
        artifact = artifact_record_for_path(target, artifact_type="archive", title=target.stem)
        with EXPORT_JOBS_LOCK:
            EXPORT_JOBS[export_id].update(
                {
                    "status": "success",
                    "progress": 100,
                    "downloadUrl": artifact["downloadUrl"],
                    "file": artifact,
                    "result": artifact,
                    "updatedAt": now_iso(),
                }
            )
    except Exception as error:
        shutil.rmtree(output_dir() / "exports" / export_id, ignore_errors=True)
        with EXPORT_JOBS_LOCK:
            if export_id in EXPORT_JOBS:
                EXPORT_JOBS[export_id].update(
                    {"status": "error", "progress": 0, "error": str(error), "updatedAt": now_iso()}
                )


def create_export_job(body: dict) -> dict:
    raw_ids = body.get("fileIds")
    if not isinstance(raw_ids, list):
        raise UploadError(400, "请选择需要打包的文件")
    artifact_ids = list(dict.fromkeys(str(value) for value in raw_ids if str(value).strip()))
    if not artifact_ids:
        raise UploadError(400, "请选择需要打包的文件")
    if len(artifact_ids) > 200:
        raise UploadError(400, "一次最多打包 200 个文件")
    targets = [output_target_from_artifact_id(artifact_id) for artifact_id in artifact_ids]
    total_bytes = ensure_export_capacity(targets)
    export_id = f"export_{uuid.uuid4().hex[:16]}"
    requested_archive_name = str(body.get("archiveName") or "").strip()
    if requested_archive_name:
        if any(char in requested_archive_name for char in ("/", "\\", "\0")):
            raise UploadError(400, "archiveName 不能包含路径")
        archive_stem = Path(requested_archive_name).stem if requested_archive_name.lower().endswith(".zip") else requested_archive_name
        archive_stem = re.sub(r"[\x00-\x1f\x7f]+", "", archive_stem).strip(" .")
        if not archive_stem or archive_stem in {".", ".."}:
            raise UploadError(400, "archiveName 无效")
        archive_name = f"{archive_stem[:120]}.zip"
    else:
        archive_name = f"SelfCanvas-{datetime.now().strftime('%Y%m%d-%H%M%S')}-{export_id[-6:]}.zip"
    job = {
        "id": export_id,
        "status": "queued",
        "progress": 0,
        "fileCount": len(artifact_ids),
        "sourceBytes": total_bytes,
        "archiveName": archive_name,
        "createdAt": now_iso(),
        "updatedAt": now_iso(),
    }
    with EXPORT_JOBS_LOCK:
        queue_limit = bounded_env_int("SELF_CANVAS_MAX_EXPORT_QUEUE", 20, 1, 200)
        pending_count = sum(
            1 for item in EXPORT_JOBS.values() if str(item.get("status") or "") in {"queued", "running"}
        )
        if pending_count >= queue_limit:
            raise UploadError(429, "打包队列已满，请稍后重试")
        EXPORT_JOBS[export_id] = job
        if len(EXPORT_JOBS) > 500:
            oldest = sorted(EXPORT_JOBS.values(), key=lambda item: item.get("createdAt", ""))[:100]
            for item in oldest:
                EXPORT_JOBS.pop(str(item.get("id") or ""), None)
    EXPORT_EXECUTOR.submit(run_export_job, export_id, artifact_ids, archive_name)
    return export_job_payload(job)


def get_export_job(export_id: str) -> dict:
    with EXPORT_JOBS_LOCK:
        job = EXPORT_JOBS.get(export_id)
        if not job:
            raise UploadError(404, "打包任务不存在")
        return export_job_payload(job)


def anycap_available() -> bool:
    return shutil.which(os.environ.get("ANYCAP_BIN", "anycap")) is not None


def model_items_from_payload(payload) -> list[dict]:
    if not isinstance(payload, dict):
        return []
    candidates = payload.get("models")
    if candidates is None and isinstance(payload.get("data"), dict):
        candidates = payload["data"].get("models")
    if candidates is None and isinstance(payload.get("data"), list):
        candidates = payload.get("data")
    if candidates is None and isinstance(payload.get("payload"), dict):
        candidates = payload["payload"].get("models")
    if not isinstance(candidates, list):
        return []
    models = []
    for item in candidates:
        if isinstance(item, str):
            models.append({"id": item, "label": item})
            continue
        if not isinstance(item, dict):
            continue
        model_id = str(item.get("model") or item.get("id") or item.get("name") or "").strip()
        if not model_id:
            continue
        models.append(
            {
                "id": canonical_video_model(model_id),
                "label": str(item.get("display_name") or item.get("label") or item.get("name") or model_id),
                "rawId": model_id,
                "description": str(item.get("description") or item.get("hint") or item.get("provider") or ""),
            }
        )
    unique = {}
    for item in models:
        unique[item["id"]] = item
    return list(unique.values())


def anycap_status_payload(body: dict) -> dict:
    endpoint = str(body.get("endpoint") or "")
    command = safe_anycap_bin(endpoint)
    if is_http_url(command):
        health = http_json_request(urljoin(command.rstrip("/") + "/", "api/health"))
        if not health.get("available"):
            health = http_json_request(urljoin(command.rstrip("/") + "/", "health"))
        return {
            "provider": "anycap",
            "available": bool(health.get("available")),
            "installed": False,
            "mode": "gateway",
            "endpoint": command,
            "message": health.get("message") or "AnyCap 网关检测完成",
            "details": health,
        }
    status = run_anycap_cli(endpoint, ["status"], timeout=10)
    payload = status.get("payload") if isinstance(status.get("payload"), dict) else {}
    text = f"{status.get('stdout', '')}\n{status.get('stderr', '')}".lower()
    authenticated = bool(
        status.get("available")
        and (
            payload.get("status") == "success"
            or payload.get("authenticated") is True
            or "authenticated" in text
            or "logged in" in text
        )
    )
    return {
        "provider": "anycap",
        "available": bool(status.get("available")),
        "installed": bool(status.get("installed")),
        "authenticated": authenticated,
        "mode": "cli",
        "bin": status.get("bin"),
        "message": status.get("message"),
        "details": {k: v for k, v in status.items() if k not in {"stdout", "stderr"}},
    }


def anycap_login_start(body: dict) -> dict:
    endpoint = str(body.get("endpoint") or "")
    command = safe_anycap_bin(endpoint)
    if is_http_url(command):
        raise RuntimeError("AnyCap 登录第一版只支持本地 CLI，不支持网关地址。")
    current_status = anycap_status_payload({"endpoint": endpoint})
    if current_status.get("authenticated"):
        return {
            "provider": "anycap",
            "available": True,
            "authenticated": True,
            "bin": current_status.get("bin") or command,
            "sessionId": "",
            "verificationUri": "",
            "userCode": "",
            "pollCommand": "",
            "nextActionHint": "AnyCap 已登录；如果要切换账号，请先点击退出登录，再重新登录获取验证码。",
            "raw": {},
        }
    result = run_anycap_cli(endpoint, ["login", "--headless", "--no-wait", "--json"], timeout=20)
    if not result.get("available"):
        raise RuntimeError(str(result.get("message") or "AnyCap 登录初始化失败"))
    payload = result.get("payload") if isinstance(result.get("payload"), dict) else {}
    session_id = str(
        payload.get("login_session_id")
        or payload.get("session_id")
        or payload.get("session")
        or ""
    )
    return {
        "provider": "anycap",
        "available": True,
        "bin": result.get("bin"),
        "sessionId": session_id,
        "verificationUri": payload.get("verification_uri") or payload.get("verification_url") or payload.get("url") or "",
        "userCode": payload.get("user_code") or payload.get("code") or "",
        "pollCommand": payload.get("poll_command") or "",
        "nextActionHint": payload.get("next_action_hint") or "打开验证链接并输入代码，完成后点击检查登录。",
        "raw": payload,
    }


def anycap_logout_payload(body: dict) -> dict:
    endpoint = str(body.get("endpoint") or "")
    command = safe_anycap_bin(endpoint)
    if is_http_url(command):
        raise RuntimeError("AnyCap 退出登录第一版只支持本地 CLI，不支持网关地址。")
    result = run_anycap_cli(endpoint, ["logout"], timeout=12)
    if not result.get("installed"):
        raise RuntimeError(str(result.get("message") or "找不到 AnyCap CLI。"))
    return {
        "provider": "anycap",
        "available": bool(result.get("available")),
        "authenticated": False,
        "bin": result.get("bin") or command,
        "message": result.get("message") or ("AnyCap 已退出登录。" if result.get("available") else "AnyCap 退出登录失败。"),
    }


def anycap_login_poll(body: dict) -> dict:
    endpoint = str(body.get("endpoint") or "")
    session_id = str(body.get("sessionId") or "").strip()
    if not session_id:
        raise RuntimeError("缺少 AnyCap login sessionId。")
    result = run_anycap_cli(endpoint, ["login", "poll", "--session", session_id, "--json", "--wait"], timeout=35)
    if not result.get("available"):
        raise RuntimeError(str(result.get("message") or "AnyCap 登录轮询失败"))
    status = anycap_status_payload({"endpoint": endpoint})
    return {**status, "message": status.get("message") or "AnyCap 登录状态已刷新。"}


def anycap_capabilities_payload(body: dict) -> dict:
    # Catalogs contain no credentials. Fetch the public schema independently of
    # login so expired credentials do not make the model picker disappear.
    endpoint = str(body.get("endpoint") or "").strip()
    base_url = endpoint if is_http_url(endpoint) else os.environ.get("ANYCAP_ENDPOINT", "https://api.anycap.ai")
    base_url = base_url.rstrip("/")
    catalog = anycap_catalog()
    source = "cached" if catalog.get("fetchedAt") else "bundled"
    recent = catalog.get("endpoint") == base_url and time.time() - float(catalog.get("fetchedAt") or 0) < 300
    if body.get("refresh") is True or not recent:
        cap_ids = ("image", "video", "audio", "music")
        def fetch_models(capability):
            result = http_json_request(f"{base_url}/v1/{capability}/models", timeout=5)
            payload = result.get("payload") or {}
            models = payload.get("models") if isinstance(payload, dict) else None
            return capability, models if result.get("available") and isinstance(models, list) else None
        with ThreadPoolExecutor(max_workers=4) as executor:
            listings = dict(executor.map(fetch_models, cap_ids))
        live_models = [(cap, item) for cap, items in listings.items() if items is not None for item in items if isinstance(item, dict)]
        def fetch_schema(pair):
            capability, item = pair
            model_id = str(item.get("model") or item.get("id") or "")
            if not model_id or not re.fullmatch(r"[a-zA-Z0-9._-]+", model_id):
                return None
            result = http_json_request(f"{base_url}/v1/{capability}/models/{quote(model_id)}/schema", timeout=6)
            payload = result.get("payload") or {}
            schemas = payload.get("schemas", []) if isinstance(payload, dict) else []
            cleaned = [
                {"operation": row.get("operation"), "mode": row.get("mode"), "parameters": row["schema"]["model_params"]}
                for row in schemas if isinstance(row, dict) and isinstance(row.get("schema"), dict)
                and isinstance(row["schema"].get("model_params"), dict) and row.get("operation") == "generate"
            ]
            if not result.get("available") or not cleaned:
                return None
            return {"id": model_id, "capability": capability, "label": item.get("display_name") or model_id,
                    "description": str(item.get("description") or ""), "operations": item.get("operations") or [], "schemas": cleaned}
        with ThreadPoolExecutor(max_workers=6) as executor:
            updated = [item for item in executor.map(fetch_schema, live_models) if item]
        if updated:
            # A partial refresh retains known schemas rather than substituting
            # invented defaults for a temporarily unavailable model schema.
            merged = {item["id"]: item for item in catalog.get("models", [])}
            merged.update({item["id"]: item for item in updated})
            for capability, items in listings.items():
                if items is not None:
                    active = {str(item.get("model") or item.get("id") or "") for item in items if isinstance(item, dict)}
                    merged = {key: value for key, value in merged.items() if value.get("capability") != capability or key in active}
            catalog = {"schemaVersion": 1, "verifiedAt": now_iso(), "fetchedAt": time.time(), "endpoint": base_url, "models": list(merged.values())}
            write_json_atomic(RUNTIME_DIR / "anycap-catalog.json", catalog)
            source = "live"
    capabilities = []
    maps = {"imageCapabilities": {}, "videoCapabilities": {}, "audioCapabilities": {}}
    for capability_id, label in (("image", "图像"), ("video", "视频"), ("audio", "语音与音效"), ("music", "音乐")):
        models = []
        for item in catalog.get("models", []):
            if item.get("capability") != capability_id:
                continue
            models.append({key: item[key] for key in ("id", "label", "description", "capability", "operations") if key in item})
            map_key = f"{capability_id}Capabilities" if capability_id in {"image", "video"} else "audioCapabilities"
            maps[map_key][item["id"]] = anycap_descriptor(item["id"])
        capabilities.append({"id": capability_id, "label": label, "available": bool(models), "models": models, "modelCount": len(models)})
    return {"provider": "anycap", "available": bool(catalog.get("models")), "installed": anycap_available(),
            "mode": "gateway" if is_http_url(endpoint) else "cli", "catalogSource": source,
            "verifiedAt": catalog.get("verifiedAt"), "capabilities": capabilities, **maps,
            "message": "AnyCap 模型与参数已同步。" if source == "live" else f"使用已验证的模型目录（{catalog.get('verifiedAt', '')}），网络恢复后可刷新。"}


def check_openai_provider(provider_id: str, body: dict) -> dict:
    endpoint = str(body.get("endpoint") or "").strip()
    api_key = str(body.get("apiKey") or "").strip()
    if provider_id == "sub2api":
        endpoint = endpoint or os.environ.get("SUB2API_BASE_URL", "http://10.0.0.239:3000")
        api_key = api_key or os.environ.get("SUB2API_API_KEY", "")
    else:
        endpoint = endpoint or os.environ.get("OPENAI_COMPATIBLE_BASE_URL", "https://api.openai.com")
        api_key = api_key or os.environ.get("OPENAI_COMPATIBLE_API_KEY", "")
    base = endpoint.rstrip("/")
    models_url = base if base.endswith("/v1/models") else f"{base}/v1/models"
    result = http_json_request(models_url, api_key=api_key, timeout=10)
    models = model_items_from_payload(result.get("payload"))
    return {
        "provider": provider_id,
        "available": bool(result.get("available")),
        "endpoint": endpoint,
        "message": result.get("message"),
        "models": models,
        "modelCount": len(models),
        "statusCode": result.get("statusCode"),
    }


def check_runninghub_provider(body: dict) -> dict:
    endpoint = str(body.get("endpoint") or os.environ.get("RUNNINGHUB_BASE_URL", "")).strip()
    if not endpoint:
        return {"provider": "runninghub", "available": False, "message": "未填写 RunningHUB Base URL。"}
    result = http_json_request(endpoint.rstrip("/") + "/", api_key=str(body.get("apiKey") or os.environ.get("RUNNINGHUB_API_KEY", "")), timeout=10)
    return {
        "provider": "runninghub",
        "available": bool(result.get("available")),
        "endpoint": endpoint,
        "message": result.get("message"),
        "statusCode": result.get("statusCode"),
    }


def check_provider(body: dict) -> dict:
    provider = str(body.get("provider") or "").strip().lower()
    if provider == "anycap":
        return anycap_status_payload(body)
    if provider in {"sub2api", "openai-compatible"}:
        return check_openai_provider(provider, body)
    if provider == "runninghub":
        return check_runninghub_provider(body)
    raise RuntimeError(f"未知 provider：{provider or '(empty)'}")


CHAT_SYSTEM_PROMPT = (
    "你是 selfcanvas 的画布聊天助手。你可以帮用户整理创意、分析图片、生成提示词，"
    "并在用户需要创建文本、图像、视频或素材节点时，给出简短明确的下一步。"
    "保持中文、简洁、可直接放进画布执行。"
)
MAX_CHAT_MESSAGES = 18
MAX_CHAT_IMAGES_PER_MESSAGE = 6
MAX_CHAT_IMAGE_CHARS = 8_000_000


def chat_image_item(raw_item) -> dict | None:
    if not isinstance(raw_item, dict):
        return None
    data_url = str(raw_item.get("dataUrl") or raw_item.get("url") or "").strip()
    if not data_url.startswith("data:image/") or ";base64," not in data_url:
        return None
    if len(data_url) > MAX_CHAT_IMAGE_CHARS:
        raise RuntimeError("单张图片过大，请压缩后再发送。")
    return {"type": "image_url", "image_url": {"url": data_url, "detail": "auto"}}


def normalize_chat_messages(raw_messages) -> list[dict]:
    if not isinstance(raw_messages, list):
        raw_messages = []
    messages = [{"role": "system", "content": CHAT_SYSTEM_PROMPT}]
    has_user = False
    for item in raw_messages[-MAX_CHAT_MESSAGES:]:
        if not isinstance(item, dict):
            continue
        role = str(item.get("role") or "").strip()
        if role not in {"user", "assistant"}:
            continue
        text = str(item.get("content") or "").strip()[:16000]
        images = item.get("images") if isinstance(item.get("images"), list) else []
        if role == "user" and images:
            content = []
            if text:
                content.append({"type": "text", "text": text})
            for image in images[:MAX_CHAT_IMAGES_PER_MESSAGE]:
                image_item = chat_image_item(image)
                if image_item:
                    content.append(image_item)
            if not content:
                content = "请分析这些图片。"
        else:
            content = text
        if not content:
            continue
        if role == "user":
            has_user = True
        messages.append({"role": role, "content": content})
    if not has_user:
        raise RuntimeError("请输入要发送给 gpt-5.5 的内容。")
    return messages


def chat_text_from_payload(payload: dict) -> str:
    choices = payload.get("choices") if isinstance(payload, dict) else None
    if not isinstance(choices, list) or not choices:
        return ""
    first = choices[0]
    if not isinstance(first, dict):
        return ""
    message = first.get("message")
    if isinstance(message, dict):
        content = message.get("content")
        if isinstance(content, str):
            return content
        if isinstance(content, list):
            parts = []
            for part in content:
                if isinstance(part, dict):
                    text = part.get("text") or part.get("content")
                    if text:
                        parts.append(str(text))
            return "\n".join(parts)
    text = first.get("text")
    return str(text) if text else ""


def sub2api_chat(body: dict) -> dict:
    endpoint = str(body.get("endpoint") or os.environ.get("SUB2API_BASE_URL", "http://10.0.0.239:3000")).strip()
    api_key = str(body.get("apiKey") or os.environ.get("SUB2API_API_KEY", "")).strip()
    model = str(body.get("model") or os.environ.get("SUB2API_CHAT_MODEL", "gpt-5.5")).strip() or "gpt-5.5"
    temperature = body.get("temperature")
    try:
        temperature = float(temperature)
    except (TypeError, ValueError):
        temperature = 0.7
    payload = {
        "model": model,
        "messages": normalize_chat_messages(body.get("messages")),
        "temperature": max(0, min(2, temperature)),
        "stream": False,
    }
    result = http_json_post(
        openai_compatible_url(endpoint, "/v1/chat/completions"),
        payload,
        api_key=api_key,
        timeout=60,
    )
    if not result.get("available"):
        raise RuntimeError(str(result.get("message") or "Sub2API chat 调用失败"))
    response_payload = result.get("payload") if isinstance(result.get("payload"), dict) else {}
    text = chat_text_from_payload(response_payload)
    if not text:
        raise RuntimeError("Sub2API 返回成功，但没有聊天文本。")
    return {
        "provider": "sub2api",
        "model": model,
        "message": text.strip(),
        "usage": response_payload.get("usage") if isinstance(response_payload, dict) else None,
    }


def mobile_config_payload() -> dict:
    media_available, media_reason = queue_available()
    video_available, video_reason = video_queue_available()
    return {
        "apiVersion": "2",
        "models": {
            "director": os.environ.get("SUB2API_STORYBOARD_MODEL", os.environ.get("SUB2API_CHAT_MODEL", "gpt-5.5")),
            "image": os.environ.get("ANYCAP_IMAGE_MODEL", "nano-banana-2"),
            "video": canonical_video_model(os.environ.get("ANYCAP_VIDEO_MODEL", "seedance-2-fast")),
            "audio": os.environ.get("ANYCAP_AUDIO_MODEL", "doubao-seed-audio-1-0"),
            "creativeVideo": os.environ.get("ANYCAP_VIDEO_EDIT_MODEL", "gemini-omni-flash-preview"),
        },
        "features": {
            "mediaGeneration": media_available,
            "videoEditing": video_available,
            "codexMcp": bool(os.environ.get("SELF_CANVAS_MCP_TOKEN", "").strip()),
            "downloads": True,
            "assetSearch": True,
        },
        "status": {
            "mediaQueue": {"available": media_available, "reason": media_reason},
            "videoEditQueue": {"available": video_available, "reason": video_reason},
        },
    }


def creative_target_models() -> dict[str, set[str]]:
    models = anycap_catalog().get("models", [])
    return {
        field: {str(item.get("id") or "") for item in models if item.get("capability") == kind}
        for field, kind in (("imageModel", "image"), ("videoModel", "video"))
    }


def creative_video_source(canvas: dict, request: dict) -> tuple[Path, dict]:
    artifacts = canvas_artifact_records(canvas, request["sourceNodeId"])
    if request["artifactId"]:
        artifacts = [item for item in artifacts if item.get("id") == request["artifactId"]]
    videos = [item for item in artifacts if item.get("type") == "video"]
    if len(videos) != 1:
        raise creative_runtime.CreativeError(400, "video_unavailable", "请选择当前画布中已落盘的一段视频；无法分析远程或不存在的素材")
    target = output_target_from_artifact_id(videos[0]["id"])
    return target, creative_runtime.inspect_video(target)


def creative_runs_read() -> dict:
    path = RUNTIME_DIR / "creative-runs.json"
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return {}
    except (OSError, ValueError, RecursionError) as error:
        raise creative_runtime.CreativeError(503, "run_store_unavailable", "创作请求记录不可用，请联系管理员；未调用模型") from error
    if not isinstance(data, dict):
        raise creative_runtime.CreativeError(503, "run_store_unavailable", "创作请求记录不可用，请联系管理员；未调用模型")
    for run_id, entry in data.items():
        valid = isinstance(run_id, str) and isinstance(entry, dict)
        valid = valid and isinstance(entry.get("fingerprint"), str) and bool(re.fullmatch(r"[a-f0-9]{64}", entry["fingerprint"]))
        valid = valid and entry.get("status") in ("running", "completed", "failed")
        if valid and entry["status"] == "completed":
            valid = isinstance(entry.get("result"), dict) and entry["result"].get("runId") == run_id
        if valid and entry["status"] == "failed":
            error = entry.get("error")
            valid = isinstance(error, dict) and type(error.get("status")) is int and 400 <= error["status"] <= 599
            valid = valid and isinstance(error.get("code"), str) and isinstance(error.get("message"), str)
        if not valid:
            # Even a null/malformed entry for a known ID must fail closed; treating
            # it as a cache miss could call a paid model for the same request again.
            raise creative_runtime.CreativeError(503, "run_store_unavailable", "创作请求记录不可用，请联系管理员；未调用模型")
    return data


def creative_runs_write(runs: dict) -> None:
    # Keep idempotency durable. Never silently evict old/unfinished paid requests.
    if len(runs) > 3000:
        raise creative_runtime.CreativeError(503, "run_store_full", "创作请求记录已达容量，请管理员先归档；未发起新调用")
    write_json_atomic(RUNTIME_DIR / "creative-runs.json", runs)


def read_creative_body(handler: BaseHTTPRequestHandler) -> dict:
    if handler.headers.get("Transfer-Encoding"):
        raise creative_runtime.CreativeError(400, "invalid_request", "创作请求不支持分块上传")
    if str(handler.headers.get("Content-Type") or "").split(";", 1)[0].strip().lower() != "application/json":
        raise creative_runtime.CreativeError(415, "invalid_request", "创作请求必须使用 application/json")
    try:
        length = int(handler.headers.get("Content-Length") or 0)
    except (TypeError, ValueError) as error:
        raise creative_runtime.CreativeError(400, "invalid_request", "请求长度无效") from error
    if length <= 0:
        raise creative_runtime.CreativeError(400, "invalid_request", "请提供创作请求 JSON")
    if length > creative_runtime.MAX_REQUEST_BYTES:
        raise creative_runtime.CreativeError(413, "request_too_large", "创作请求超过 512 KiB，请缩短输入正文")
    previous_timeout = handler.connection.gettimeout()
    try:
        handler.connection.settimeout(15)
        raw = handler.rfile.read(length)
        if len(raw) != length:
            raise creative_runtime.CreativeError(400, "invalid_request", "创作请求未完整上传")
        body = json.loads(raw.decode("utf-8"))
    except TimeoutError as error:
        raise creative_runtime.CreativeError(408, "request_timeout", "创作请求上传超时，未调用模型") from error
    except (ValueError, RecursionError) as error:
        raise creative_runtime.CreativeError(400, "invalid_request", "创作请求不是有效的 UTF-8 JSON") from error
    finally:
        handler.connection.settimeout(previous_timeout)
    if not isinstance(body, dict):
        raise creative_runtime.CreativeError(400, "invalid_request", "创作请求必须是 JSON 对象")
    return body


def create_creative_run(body: dict) -> dict:
    # Basic validation precedes replay; catalog removals must not make a paid
    # completed request impossible to retrieve using its original request ID.
    request = creative_runtime.validate_request(body)
    record = read_project_record()
    project, canvas = require_project_canvas(record, request["canvasId"])
    scope = f"{project.get('id') or ''}:{request['canvasId']}:{request['requestId']}"
    run_id = "creative_" + hashlib.sha256(scope.encode("utf-8")).hexdigest()[:32]
    fingerprint = hashlib.sha256(json.dumps(request, sort_keys=True, ensure_ascii=False).encode("utf-8")).hexdigest()
    with CREATIVE_RUNS_LOCK:
        runs = creative_runs_read()
        cached = runs.get(run_id)
        if cached:
            if cached.get("fingerprint") != fingerprint:
                raise creative_runtime.CreativeError(409, "request_id_conflict", "此 requestId 已用于不同内容，请使用新的请求 ID")
            if cached.get("status") == "completed":
                return copy.deepcopy(cached["result"])
            if cached.get("status") == "failed":
                failure = cached["error"]
                raise creative_runtime.CreativeError(failure["status"], failure["code"], failure["message"])
            raise creative_runtime.CreativeError(409, "request_in_progress", "该请求正在执行，或上次执行结果尚不确定；为避免重复计费不会再次调用")
        creative_runtime.validate_request(body, creative_target_models())
        config = creative_runtime.gateway_config(request["kind"], request["model"])
        video = creative_video_source(canvas, request) if request["kind"] == "video-analysis" else None
        context = {field: anycap_descriptor(request[field]) for field in ("imageModel", "videoModel") if request[field]}
        creative_runtime.validate_target_timing(request, context)
        system = creative_runtime.build_system_prompt(ROOT, request, context)
        if not CREATIVE_RUN_SLOTS.acquire(blocking=False):
            raise creative_runtime.CreativeError(429, "creative_busy", "当前已有两个创作请求在运行，请稍后手动提交")
        entry = {"status": "running", "fingerprint": fingerprint, "savedAt": now_iso()}
        runs[run_id] = entry
        try:
            creative_runs_write(runs)
        except Exception:
            CREATIVE_RUN_SLOTS.release()
            raise
    try:
        raw = creative_runtime.gateway_request(config, system, request, video)
        draft = creative_runtime.validate_draft(raw, request, video[1]["durationSeconds"] if video else None, context)
        warnings = ["候选草稿尚未写入画布；请检查内容后手动导入。", "本次只生成剧本、提示词或分析，不会自动生成图片或视频。"]
        if request["kind"] == "storyboard":
            warnings.append("分镜当前只有文字连续性约束，尚未绑定角色/场景参考图；生成图片前请补充并核对参考素材。")
        if video and config["protocol"] == "openai":
            warnings.append("OpenAI 兼容视频模式要求网关支持 video_url 内联视频扩展。")
        result = {"runId": run_id, "kind": request["kind"], "model": config["model"], "sourceRevision": record["revision"], "canvasId": request["canvasId"], "draft": draft, "skillSources": creative_runtime.SKILL_SOURCES, "warnings": warnings, **{field: request[field] for field in ("imageModel", "videoModel", "sourceNodeId", "aspectRatio")}}
        with CREATIVE_RUNS_LOCK:
            runs = creative_runs_read()
            runs[run_id] = {**entry, "status": "completed", "result": result, "savedAt": now_iso()}
            creative_runs_write(runs)
        return result
    except Exception as error:
        public = error if isinstance(error, creative_runtime.CreativeError) else creative_runtime.CreativeError(500, "creative_failed", "创作服务发生异常；为避免重复计费，未自动重试")
        with CREATIVE_RUNS_LOCK:
            runs = creative_runs_read()
            runs[run_id] = {**entry, "status": "failed", "error": {"status": public.status, "code": public.code, "message": str(public)}, "savedAt": now_iso()}
            creative_runs_write(runs)
        raise public from error
    finally:
        CREATIVE_RUN_SLOTS.release()


class SelfCanvasHandler(BaseHTTPRequestHandler):
    server_version = "SelfCanvasBridge/0.1"

    def log_message(self, fmt: str, *args) -> None:
        print(f"[server] {self.address_string()} - {fmt % args}")

    def end_headers(self) -> None:
        origin = str(self.headers.get("Origin") or "").strip()
        host = str(self.headers.get("Host") or "").strip()
        allowed = configured_allowed_origins()
        if origin and (origin in allowed or origin in {f"http://{host}", f"https://{host}"}):
            self.send_header("Access-Control-Allow-Origin", origin)
            self.send_header("Access-Control-Allow-Credentials", "true")
            self.send_header("Vary", "Origin")
        super().end_headers()

    def do_OPTIONS(self) -> None:
        self.send_response(204)
        self.send_header(
            "Access-Control-Allow-Headers",
            "Content-Type, Authorization, X-File-Name, X-Request-Id, X-SelfCanvas-CSRF",
        )
        self.send_header("Access-Control-Allow-Methods", "GET, POST, PUT, OPTIONS")
        self.end_headers()

    def do_GET(self) -> None:
        parsed = urlparse(self.path)
        path = parsed.path
        query = parse_qs(parsed.query)
        if path == "/api/browser/session":
            try:
                create_browser_session(self)
            except UploadError as error:
                send_error_json(self, error.status, str(error))
            return
        if path == "/api/health":
            available, reason = queue_available()
            video_available, video_reason = video_queue_available()
            send_json(
                self,
                200,
                {
                    "status": "ok",
                    "queue": {"available": available, "reason": reason},
                    "videoEditQueue": {"available": video_available, "reason": video_reason},
                    "outputDir": str(output_dir()),
                },
            )
            return
        if path == "/api/auth/me":
            try:
                send_json(self, 200, {"user": mobile_current_user(self)}, {"Cache-Control": "no-store"})
            except UploadError as error:
                send_error_json(self, error.status, str(error))
            return
        if path == "/api/mobile/config":
            try:
                require_v2_api_token(self)
                send_json(self, 200, mobile_config_payload())
            except UploadError as error:
                send_error_json(self, error.status, str(error))
            return
        if path == "/api/v2/creative/capabilities":
            try:
                require_v2_api_token(self)
                send_json(self, 200, creative_runtime.capabilities(), {"Cache-Control": "no-store"})
            except UploadError as error:
                send_error_json(self, error.status, str(error))
            return
        if path == "/api/config":
            available, reason = queue_available()
            video_available, video_reason = video_queue_available()
            send_json(
                self,
                200,
                {
                    "sub2api": {
                        "baseUrl": os.environ.get("SUB2API_BASE_URL", "http://10.0.0.239:3000"),
                        "hasApiKey": bool(os.environ.get("SUB2API_API_KEY")),
                        "chatModel": os.environ.get("SUB2API_CHAT_MODEL", "gpt-5.5"),
                        "textModel": os.environ.get("SUB2API_TEXT_MODEL", "gpt-4o-mini"),
                        "imageModel": os.environ.get("SUB2API_IMAGE_MODEL", "gpt-image-2"),
                    },
                    "anycap": {
                        "available": anycap_available(),
                        "bin": os.environ.get("ANYCAP_BIN", "anycap"),
                        "imageModel": os.environ.get("ANYCAP_IMAGE_MODEL", "nano-banana-2"),
                        "videoModel": canonical_video_model(os.environ.get("ANYCAP_VIDEO_MODEL", "seedance-2-fast")),
                        "audioModel": os.environ.get("ANYCAP_AUDIO_MODEL", ""),
                        "videoCapabilities": ANYCAP_VIDEO_CAPABILITIES,
                    },
                    "queue": {"available": available, "reason": reason},
                    "videoEditQueue": {"available": video_available, "reason": video_reason},
                },
            )
            return
        if path == "/api/project":
            try:
                send_json(self, 200, read_project_record())
            except Exception as error:
                send_error_json(self, 500, str(error))
            return
        if path == "/api/v2/events":
            try:
                since_revision = int((query.get("sinceRevision") or ["0"])[0] or 0)
                self.serve_project_events(since_revision)
            except UploadError as error:
                send_error_json(self, error.status, str(error))
            except Exception as error:
                send_error_json(self, 400, str(error))
            return
        if path == "/api/v2/canvases":
            try:
                require_v2_api_token(self)
                send_json(self, 200, canvases_v2(query))
            except UploadError as error:
                send_error_json(self, error.status, str(error))
            return
        if path.startswith("/api/v2/canvases/"):
            try:
                require_v2_api_token(self)
                segments = [unquote(part) for part in path.split("/") if part]
                if len(segments) < 4:
                    raise UploadError(404, "Not found")
                canvas_id = segments[3]
                if len(segments) == 4:
                    send_json(self, 200, canvas_v2(canvas_id, query))
                    return
                if len(segments) == 5 and segments[4] == "nodes":
                    send_json(self, 200, search_canvas_nodes_v2(canvas_id, query))
                    return
                if len(segments) == 5 and segments[4] == "artifacts":
                    send_json(self, 200, list_canvas_artifacts_v2(canvas_id, query))
                    return
                raise UploadError(404, "Not found")
            except UploadError as error:
                send_error_json(self, error.status, str(error))
            return
        if path.startswith("/api/v2/jobs/"):
            try:
                require_v2_api_token(self)
                send_json(self, 200, get_job_v2(unquote(path.rsplit("/", 1)[-1])))
            except UploadError as error:
                send_error_json(self, error.status, str(error))
            except Exception as error:
                send_error_json(self, 404 if "不存在" in str(error) else 503, str(error))
            return
        if path == "/api/generation/jobs":
            try:
                send_json(self, 200, list_all_jobs())
            except Exception as error:
                send_error_json(self, 503, str(error))
            return
        if path == "/api/mobile/jobs":
            try:
                require_v2_api_token(self)
                send_json(self, 200, list_all_jobs())
            except UploadError as error:
                send_error_json(self, error.status, str(error))
            except Exception as error:
                send_error_json(self, 503, str(error))
            return
        if path.startswith("/api/generation/jobs/"):
            job_id = path.rsplit("/", 1)[-1]
            try:
                send_json(self, 200, get_any_job(job_id))
            except Exception as error:
                send_error_json(self, 404 if "不存在" in str(error) else 503, str(error))
            return
        if path.startswith("/api/exports/"):
            try:
                send_json(self, 200, get_export_job(unquote(path.rsplit("/", 1)[-1])))
            except UploadError as error:
                send_error_json(self, error.status, str(error))
            return
        if path == "/api/files":
            send_json(self, 200, list_output_files())
            return
        if path == "/api/mobile/artifacts":
            try:
                require_v2_api_token(self)
                send_json(self, 200, list_output_files())
            except UploadError as error:
                send_error_json(self, error.status, str(error))
            return
        if path.startswith("/api/files/download/"):
            self.serve_artifact_download(unquote(path.rsplit("/", 1)[-1]))
            return
        if path == "/api/settings/storage":
            send_json(self, 200, storage_payload())
            return
        if path.startswith("/output/"):
            self.serve_output_file(path)
            return
        self.serve_static(path)

    def do_POST(self) -> None:
        parsed = urlparse(self.path)
        path = parsed.path
        if path == "/api/auth/login":
            try:
                send_json(self, 200, mobile_login(read_json_body(self)), {"Cache-Control": "no-store"})
            except UploadError as error:
                send_error_json(self, error.status, str(error))
            except Exception as error:
                send_error_json(self, 500, f"登录服务不可用：{error}")
            return
        if path == "/api/auth/refresh":
            try:
                send_json(self, 200, mobile_refresh(read_json_body(self)), {"Cache-Control": "no-store"})
            except UploadError as error:
                send_error_json(self, error.status, str(error))
            except Exception as error:
                send_error_json(self, 500, f"登录刷新失败：{error}")
            return
        if path == "/api/auth/logout":
            try:
                send_json(self, 200, mobile_logout(self, read_json_body(self)), {"Cache-Control": "no-store"})
            except UploadError as error:
                send_error_json(self, error.status, str(error))
            return
        try:
            require_write_access(self)
        except UploadError as error:
            send_error_json(self, error.status, str(error))
            return
        if path == "/api/v2/creative/runs":
            try:
                require_v2_api_token(self)
                send_json(self, 200, create_creative_run(read_creative_body(self)), {"Cache-Control": "no-store"})
            except creative_runtime.CreativeError as error:
                send_json(self, error.status, {"error": str(error), "code": error.code}, {"Cache-Control": "no-store"})
            except UploadError as error:
                send_error_json(self, error.status, str(error))
            except Exception:
                send_error_json(self, 500, "创作服务暂不可用；请检查服务端日志，未自动重试")
            return
        if path == "/api/exports":
            try:
                send_json(self, 202, create_export_job(read_json_body(self)))
            except UploadError as error:
                send_error_json(self, error.status, str(error))
            except Exception as error:
                send_error_json(self, 500, f"文件打包失败：{error}")
            return
        if path == "/api/v2/downloads":
            try:
                require_v2_api_token(self)
                send_json(self, 202, prepare_download_v2(read_json_body(self)))
            except ProjectRevisionConflict as error:
                send_json(self, 409, {"error": {"code": "revision_conflict", "message": str(error)}, **error.record})
            except UploadError as error:
                send_error_json(self, error.status, str(error))
            return
        if path.startswith("/api/v2/canvases/"):
            try:
                require_v2_api_token(self)
                segments = [unquote(part) for part in path.split("/") if part]
                if len(segments) < 5:
                    raise UploadError(404, "Not found")
                canvas_id = segments[3]
                body = read_json_body(self)
                if len(segments) == 5 and segments[4] == "operations":
                    send_json(self, 200, apply_canvas_operations(canvas_id, body))
                    return
                if len(segments) == 5 and segments[4] == "video-edits":
                    send_json(self, 202, create_video_edit_job(canvas_id, body))
                    return
                if len(segments) == 7 and segments[4] == "nodes" and segments[6] == "run":
                    send_json(self, 202, start_saved_node_job(canvas_id, segments[5], body))
                    return
                raise UploadError(404, "Not found")
            except ProjectRevisionConflict as error:
                send_json(
                    self,
                    409,
                    {"error": {"code": "revision_conflict", "message": str(error)}, **sanitize_public_value(error.record)},
                )
            except UploadError as error:
                send_error_json(self, error.status, str(error))
            except Exception as error:
                send_error_json(self, 503, str(error))
            return
        if path == "/api/settings/storage":
            try:
                send_json(self, 200, apply_storage_root(str(read_json_body(self).get("saveRoot") or "")))
            except Exception as error:
                send_error_json(self, 400, str(error))
            return
        if path == "/api/settings/storage/select":
            try:
                send_json(self, 200, choose_storage_root())
            except Exception as error:
                send_error_json(self, 409 if "取消" in str(error) else 400, str(error))
            return
        if path == "/api/files/upload":
            try:
                send_json(self, 201, receive_media_upload(self))
            except UploadError as error:
                send_error_json(self, error.status, str(error))
            except Exception as error:
                send_error_json(self, 500, f"文件导入失败：{error}")
            return
        if path == "/api/generation/jobs":
            try:
                send_json(self, 202, create_job(read_json_body(self)))
            except Exception as error:
                send_error_json(self, 503, f"后台任务不可用：{error}")
            return
        if path.startswith("/api/generation/jobs/") and path.endswith("/cancel"):
            job_id = path.split("/")[-2]
            try:
                send_json(self, 200, cancel_any_job(job_id))
            except Exception as error:
                send_error_json(self, 503, str(error))
            return
        if path == "/api/providers/check":
            try:
                send_json(self, 200, check_provider(read_json_body(self)))
            except Exception as error:
                send_error_json(self, 503, str(error))
            return
        if path == "/api/providers/anycap/login/start":
            try:
                send_json(self, 200, anycap_login_start(read_json_body(self)))
            except Exception as error:
                send_error_json(self, 503, str(error))
            return
        if path == "/api/providers/anycap/login/poll":
            try:
                send_json(self, 200, anycap_login_poll(read_json_body(self)))
            except Exception as error:
                send_error_json(self, 503, str(error))
            return
        if path == "/api/providers/anycap/logout":
            try:
                send_json(self, 200, anycap_logout_payload(read_json_body(self)))
            except Exception as error:
                send_error_json(self, 503, str(error))
            return
        if path == "/api/providers/anycap/capabilities":
            try:
                send_json(self, 200, anycap_capabilities_payload(read_json_body(self)))
            except Exception as error:
                send_error_json(self, 503, str(error))
            return
        if path == "/api/chat/sub2api":
            try:
                send_json(self, 200, sub2api_chat(read_json_body(self)))
            except Exception as error:
                send_error_json(self, 503, str(error))
            return
        send_error_json(self, 404, "Not found")

    def do_PUT(self) -> None:
        parsed = urlparse(self.path)
        if parsed.path != "/api/project":
            send_error_json(self, 404, "Not found")
            return
        try:
            require_write_access(self)
            payload = read_json_body(self)
            send_json(
                self,
                200,
                save_project_state(payload.get("project"), int(payload.get("baseRevision") or 0)),
            )
        except ProjectRevisionConflict as error:
            send_json(self, 409, {"error": "revision_conflict", **error.record})
        except UploadError as error:
            send_error_json(self, error.status, str(error))
        except Exception as error:
            send_error_json(self, 400, str(error))

    def serve_output_file(self, request_path: str) -> None:
        rel = unquote(request_path[len("/output/") :])
        target = (output_dir() / rel).resolve()
        base = output_dir().resolve()
        try:
            target.relative_to(base)
        except ValueError:
            send_error_json(self, 404, "文件不存在")
            return
        if not target.exists() or not target.is_file():
            send_error_json(self, 404, "文件不存在")
            return
        self.send_file(target)

    def serve_artifact_download(self, artifact_id: str) -> None:
        try:
            target = output_target_from_artifact_id(artifact_id)
            self.send_file(target, download_name=target.name)
        except UploadError as error:
            send_error_json(self, error.status, str(error))

    def serve_project_events(self, since_revision: int) -> None:
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream; charset=utf-8")
        self.send_header("Cache-Control", "no-cache, no-transform")
        # The browser client consumes one event with response.text() and then
        # reconnects. Close each short-poll response so the promise resolves.
        self.send_header("Connection", "close")
        self.end_headers()
        self.close_connection = True
        try:
            def response_event():
                with PROJECT_EVENT_CONDITION:
                    event = getattr(PROJECT_EVENT_CONDITION, "event", None)
                if isinstance(event, dict) and int(event.get("revision") or 0) > since_revision:
                    return event
                record = read_project_record()
                if int(record.get("revision") or 0) > since_revision:
                    payload = {
                        "type": "project.snapshot",
                        "revision": int(record.get("revision") or 0),
                        "savedAt": str(record.get("savedAt") or ""),
                    }
                    project = record.get("project") if isinstance(record.get("project"), dict) else {}
                    for canvas in project.get("canvases", []) if isinstance(project, dict) else []:
                        if not isinstance(canvas, dict):
                            continue
                        if int(canvas.get("focusRevision") or 0) != int(record.get("revision") or 0):
                            continue
                        payload.update(
                            {
                                "canvasId": str(canvas.get("id") or ""),
                                "focusNodeId": str(canvas.get("focusNodeId") or ""),
                                "focusRequestId": str(canvas.get("focusRequestId") or ""),
                            }
                        )
                        break
                    return payload
                return None

            payload = response_event()
            if payload is None:
                with PROJECT_EVENT_CONDITION:
                    PROJECT_EVENT_CONDITION.wait(timeout=8)
                payload = response_event()
            if payload is not None:
                self.wfile.write(f"event: project\ndata: {json.dumps(payload, ensure_ascii=False)}\n\n".encode("utf-8"))
            else:
                self.wfile.write(b": heartbeat\n\n")
            self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError):
            return

    def serve_static(self, request_path: str) -> None:
        if not DIST_DIR.exists():
            send_error_json(self, 404, "dist 不存在，请先运行 npm run build 或使用 Vite dev server")
            return
        rel = request_path.lstrip("/") or "index.html"
        base = DIST_DIR.resolve()
        target = (base / rel).resolve()
        try:
            target.relative_to(base)
        except ValueError:
            target = base / "index.html"
        if not target.exists() or not target.is_file():
            target = DIST_DIR / "index.html"
        self.send_file(target)

    def send_file(self, target: Path, download_name: str | None = None) -> None:
        content_type = mimetypes.guess_type(str(target))[0] or "application/octet-stream"
        if target.suffix.lower() == ".svg":
            download_name = download_name or target.name
        size = target.stat().st_size
        start = 0
        end = max(0, size - 1)
        range_header = self.headers.get("Range")
        partial = False
        if range_header:
            try:
                if not range_header.startswith("bytes=") or "," in range_header:
                    raise ValueError("unsupported range")
                start_text, end_text = range_header[6:].split("-", 1)
                if start_text:
                    start = int(start_text)
                    end = int(end_text) if end_text else size - 1
                else:
                    suffix_length = int(end_text)
                    if suffix_length <= 0:
                        raise ValueError("invalid suffix")
                    start = max(0, size - suffix_length)
                    end = size - 1
                if size <= 0 or start < 0 or start >= size or end < start:
                    raise ValueError("range outside file")
                end = min(end, size - 1)
                partial = True
            except (TypeError, ValueError):
                self.send_response(416)
                self.send_header("Content-Range", f"bytes */{size}")
                self.send_header("Content-Length", "0")
                self.end_headers()
                return

        content_length = 0 if size <= 0 else end - start + 1
        self.send_response(206 if partial else 200)
        self.send_header("Content-Type", content_type)
        self.send_header("X-Content-Type-Options", "nosniff")
        if target.suffix.lower() == ".svg":
            self.send_header("Content-Security-Policy", "sandbox")
        self.send_header("Accept-Ranges", "bytes")
        self.send_header("Content-Length", str(content_length))
        if download_name:
            fallback = re.sub(r"[^A-Za-z0-9._-]+", "_", download_name) or "download"
            self.send_header(
                "Content-Disposition",
                f"attachment; filename=\"{fallback}\"; filename*=UTF-8''{quote(download_name)}",
            )
        if partial:
            self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
        self.end_headers()
        if content_length <= 0:
            return
        try:
            with target.open("rb") as source:
                source.seek(start)
                remaining = content_length
                while remaining > 0:
                    chunk = source.read(min(UPLOAD_CHUNK_SIZE, remaining))
                    if not chunk:
                        break
                    self.wfile.write(chunk)
                    remaining -= len(chunk)
        except (BrokenPipeError, ConnectionResetError):
            return


def main() -> None:
    output_dir().mkdir(parents=True, exist_ok=True)
    RUNTIME_DIR.mkdir(parents=True, exist_ok=True)
    artifact_secret()
    threading.Thread(target=managed_job_projector_loop, name="managed-job-projector", daemon=True).start()
    host = os.environ.get("SELF_CANVAS_HOST", "127.0.0.1")
    port = int(os.environ.get("SELF_CANVAS_PORT", "8787"))
    server = ThreadingHTTPServer((host, port), SelfCanvasHandler)
    print(f"[server] SelfCanvas bridge listening at http://{host}:{port}")
    print(f"[server] Output directory: {output_dir()}")
    server.serve_forever()


if __name__ == "__main__":
    main()
