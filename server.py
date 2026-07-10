#!/usr/bin/env python3
from __future__ import annotations

import json
import mimetypes
import os
import re
import shutil
import subprocess
import sys
import tempfile
import uuid
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import quote, unquote, urljoin, urlparse
from urllib.request import Request, urlopen


ROOT = Path(__file__).resolve().parent
DIST_DIR = ROOT / "dist"
RUNTIME_DIR = ROOT / ".runtime"
STORAGE_CONFIG_PATH = RUNTIME_DIR / "storage.json"
QUEUE_SCRIPT = ROOT / "scripts" / "generation-queue.mjs"


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


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def read_storage_config() -> dict:
    try:
        payload = json.loads(STORAGE_CONFIG_PATH.read_text(encoding="utf-8"))
        return payload if isinstance(payload, dict) else {}
    except (OSError, json.JSONDecodeError):
        return {}


def configured_save_root() -> Path | None:
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
    "seedance-2-fast": {
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


def video_capability(model: str) -> dict:
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
        return canonical_video_model(requested) if kind == "video" else requested
    if kind == "text":
        return os.environ.get("SUB2API_TEXT_MODEL", "gpt-4o-mini")
    if kind == "image":
        return os.environ.get("SUB2API_IMAGE_MODEL", "gpt-image-2")
    if kind == "video":
        return canonical_video_model(os.environ.get("ANYCAP_VIDEO_MODEL", "seedance-2-fast"))
    if kind == "audio":
        return os.environ.get("ANYCAP_AUDIO_MODEL", "anycap-audio")
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
    clean["aspectRatio"] = aspect_ratio if aspect_ratio == "adaptive" or aspect_ratio in ratios else "adaptive"
    if mode == "multi-shot-video":
        try:
            shot_count = int(clean.get("shotCount") or 3)
        except (TypeError, ValueError):
            shot_count = 3
        clean["shotCount"] = max(1, min(12, shot_count))
    else:
        clean.pop("shotCount", None)
    return clean


def validate_video_references(model: str, references: list[dict], mode: str = "") -> None:
    if not references:
        return
    counts = {"image": 0, "video": 0, "audio": 0}
    for ref in references:
        output_type = ref.get("outputType")
        if output_type in counts:
            counts[output_type] += 1
    limits = video_reference_limits(model, mode)
    labels = {"image": "参考图", "video": "参考视频", "audio": "参考音频"}
    for output_type, count in counts.items():
        limit = int(limits.get(output_type) or 0)
        if count > limit:
            if limit <= 0:
                raise RuntimeError(f"{model} 当前模式暂不支持{labels[output_type]}")
            raise RuntimeError(f"{model} 最多支持 {limit} 个{labels[output_type]}，当前是 {count} 个")


def create_job(payload: dict):
    available, reason = queue_available()
    if not available:
        raise RuntimeError(reason)
    kind = str(payload.get("kind") or "text")
    options = sanitize_options(kind, payload)
    references = sanitize_references(payload)
    requested_model = str(options.get("model") or payload.get("model") or "")
    provider_tool = str(options.get("providerTool") or "")
    model = route_model(kind, requested_model)
    if kind == "video":
        options = normalize_video_options(model, options)
        validate_video_references(model, references, str(options.get("mode") or ""))
    if kind == "storyboard":
        options = normalize_storyboard_options(options)
        for reference in references:
            if reference.get("outputType") == "text" and not str(reference.get("content") or "").strip():
                raise RuntimeError(f"引用的文本节点“{reference.get('title') or '未命名'}”尚未生成正文")
    created_at = now_iso()
    job = {
        "id": f"job_{uuid.uuid4().hex[:14]}",
        "nodeId": str(payload.get("nodeId") or ""),
        "targetNodeId": str(payload.get("targetNodeId") or payload.get("nodeId") or ""),
        "kind": kind,
        "title": str(payload.get("title") or kind),
        "provider": route_provider(kind, str(payload.get("provider") or ""), provider_tool),
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
    suffix = Path(original).suffix.lower()
    if suffix not in MEDIA_TYPES:
        raise UploadError(415, f"不支持的媒体格式：{suffix or '无扩展名'}")
    stem = Path(original).stem
    cleaned_stem = "".join(char if char.isalnum() or char in "._- " else "_" for char in stem)
    cleaned_stem = re.sub(r"\s+", "_", cleaned_stem).strip("._-") or "media"
    return original, f"{cleaned_stem[:120]}{suffix}"


def output_display_title(path: Path) -> str:
    stem = path.stem
    if "--" not in stem:
        return stem
    prefix, display = stem.split("--", 1)
    if len(prefix) == 32 and all(char in "0123456789abcdef" for char in prefix.lower()):
        return display
    return stem


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
    upload_dir = output_dir() / "uploads" / datetime.now(timezone.utc).strftime("%Y-%m-%d")
    upload_dir.mkdir(parents=True, exist_ok=True)
    token = uuid.uuid4().hex
    target = upload_dir / f"{token}--{safe_name}"
    temporary = upload_dir / f".{token}.part"
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
        raise

    rel = target.relative_to(output_dir()).as_posix()
    requested_mime = (handler.headers.get("Content-Type") or "").split(";", 1)[0].strip()
    guessed_mime = mimetypes.guess_type(str(target))[0] or "application/octet-stream"
    mime_type = requested_mime if requested_mime.startswith(f"{media_type}/") else guessed_mime
    return {
        "id": rel,
        "name": original_name,
        "type": media_type,
        "mimeType": mime_type,
        "size": target.stat().st_size,
        "url": f"/output/{quote(rel)}",
        "path": str(target),
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
                "title": output_display_title(path),
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
                "label": str(item.get("label") or item.get("name") or model_id),
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
    endpoint = str(body.get("endpoint") or "")
    status = anycap_status_payload({"endpoint": endpoint})
    if status.get("mode") != "cli":
        return {
            **status,
            "capabilities": [],
            "videoCapabilities": ANYCAP_VIDEO_CAPABILITIES,
            "message": status.get("message") or "AnyCap 网关模式暂不支持 CLI 模型扫描。",
        }
    capabilities = []
    for capability_id, label in [("image", "图像"), ("video", "视频"), ("music", "音乐/音频")]:
        result = run_anycap_cli(endpoint, [capability_id, "models"], timeout=16)
        payload = result.get("payload") if isinstance(result.get("payload"), dict) else {}
        models = model_items_from_payload(payload)
        capabilities.append(
            {
                "id": capability_id,
                "label": label,
                "available": bool(result.get("available")),
                "models": models,
                "modelCount": len(models),
                "message": result.get("message"),
            }
        )
    discovered_video_ids = {
        item["id"]
        for capability in capabilities
        if capability["id"] == "video"
        for item in capability.get("models", [])
    }
    merged_video_capabilities = {
        **ANYCAP_VIDEO_CAPABILITIES,
        **{
            model_id: video_capability(model_id)
            for model_id in discovered_video_ids
            if model_id not in ANYCAP_VIDEO_CAPABILITIES
        },
    }
    return {
        **status,
        "available": bool(status.get("installed")),
        "capabilities": capabilities,
        "videoCapabilities": merged_video_capabilities,
        "message": "AnyCap 能力和模型扫描完成。",
    }


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
        self.send_header("Access-Control-Allow-Headers", "Content-Type, Authorization, X-File-Name")
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
                        "chatModel": os.environ.get("SUB2API_CHAT_MODEL", "gpt-5.5"),
                        "textModel": os.environ.get("SUB2API_TEXT_MODEL", "gpt-4o-mini"),
                        "imageModel": os.environ.get("SUB2API_IMAGE_MODEL", "gpt-image-2"),
                    },
                    "anycap": {
                        "available": anycap_available(),
                        "bin": os.environ.get("ANYCAP_BIN", "anycap"),
                        "videoModel": canonical_video_model(os.environ.get("ANYCAP_VIDEO_MODEL", "seedance-2-fast")),
                        "audioModel": os.environ.get("ANYCAP_AUDIO_MODEL", ""),
                        "videoCapabilities": ANYCAP_VIDEO_CAPABILITIES,
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
                send_json(self, 200, run_queue("cancel", job_id, timeout=8))
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
        self.send_header("Accept-Ranges", "bytes")
        self.send_header("Content-Length", str(content_length))
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
    host = os.environ.get("SELF_CANVAS_HOST", "127.0.0.1")
    port = int(os.environ.get("SELF_CANVAS_PORT", "8787"))
    server = ThreadingHTTPServer((host, port), SelfCanvasHandler)
    print(f"[server] SelfCanvas bridge listening at http://{host}:{port}")
    print(f"[server] Output directory: {output_dir()}")
    server.serve_forever()


if __name__ == "__main__":
    main()
