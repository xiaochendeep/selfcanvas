from __future__ import annotations

import json
import io
import os
import tempfile
import threading
import time
import unittest
import zipfile
from contextlib import contextmanager
from http.client import HTTPConnection
from pathlib import Path
from unittest import mock
from urllib.error import HTTPError
from urllib.parse import quote, urlparse
from urllib.request import Request, urlopen

import server


def sample_project(*, absolute_path: str = "") -> dict:
    return {
        "id": "project_test",
        "activeCanvasId": "canvas_main",
        "updatedAt": "2026-07-13T00:00:00+00:00",
        "canvases": [
            {
                "id": "canvas_main",
                "name": "主画布",
                "updatedAt": "2026-07-13T00:00:00+00:00",
                "nodes": [
                    {
                        "id": "node_image",
                        "type": "studioNode",
                        "position": {"x": 10, "y": 20},
                        "data": {
                            "kind": "image",
                            "title": "茶铺场景",
                            "prompt": "雨夜茶铺",
                            "importedMedia": {
                                "name": "茶铺 场景.png",
                                "path": absolute_path,
                            },
                            "outputs": {
                                "assetName": "茶铺 场景.png",
                                "path": absolute_path,
                            },
                        },
                    }
                ],
                "edges": [],
                "groups": [],
                "viewport": {"x": 0, "y": 0, "zoom": 1},
            }
        ],
    }


class ServerContractTest(unittest.TestCase):
    def setUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory()
        self.root = Path(self.temp_dir.name)
        self.storage_root = self.root / "storage"
        self.output = self.storage_root / "output"
        self.runtime = self.root / "runtime"
        self.output.mkdir(parents=True)
        self.runtime.mkdir(parents=True)

        self.env = mock.patch.dict(
            os.environ,
            {
                "SELF_CANVAS_STORAGE_ROOT": str(self.storage_root),
                "SELF_CANVAS_ARTIFACT_SECRET": "unit-test-artifact-secret",
                "SELF_CANVAS_API_TOKEN": "unit-test-api-token",
            },
        )
        self.env.start()
        self.path_patches = [
            mock.patch.object(server, "PROJECT_STATE_PATH", self.runtime / "project.json"),
            mock.patch.object(server, "IDEMPOTENCY_PATH", self.runtime / "idempotency.json"),
            mock.patch.object(server, "MANAGED_JOBS_PATH", self.runtime / "managed-jobs.json"),
            mock.patch.object(server, "ARTIFACT_SECRET_PATH", self.runtime / "artifact-secret"),
            mock.patch.object(server, "STORAGE_CONFIG_PATH", self.runtime / "storage.json"),
        ]
        for patcher in self.path_patches:
            patcher.start()
        with server.EXPORT_JOBS_LOCK:
            server.EXPORT_JOBS.clear()
        with server.BROWSER_SESSIONS_LOCK:
            server.BROWSER_SESSIONS.clear()

    def tearDown(self) -> None:
        with server.EXPORT_JOBS_LOCK:
            server.EXPORT_JOBS.clear()
        with server.BROWSER_SESSIONS_LOCK:
            server.BROWSER_SESSIONS.clear()
        for patcher in reversed(self.path_patches):
            patcher.stop()
        self.env.stop()
        self.temp_dir.cleanup()

    def seed_project(self, revision: int = 1) -> None:
        server.write_json_atomic(
            server.PROJECT_STATE_PATH,
            {
                "schemaVersion": 1,
                "revision": revision,
                "savedAt": "2026-07-13T00:00:00+00:00",
                "project": sample_project(absolute_path=str(self.root / "must-not-leak.png")),
            },
        )

    def make_file(self, relative: str, data: bytes) -> Path:
        target = self.output / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(data)
        return target

    @contextmanager
    def http_server(self):
        httpd = server.ThreadingHTTPServer(("127.0.0.1", 0), server.SelfCanvasHandler)
        thread = threading.Thread(target=httpd.serve_forever, daemon=True)
        thread.start()
        try:
            yield f"http://127.0.0.1:{httpd.server_port}"
        finally:
            httpd.shutdown()
            httpd.server_close()
            thread.join(timeout=2)

    def request_json(self, base_url: str, path: str, body: dict) -> tuple[int, dict]:
        return self.request_json_with_headers(
            base_url,
            path,
            body,
            {"Authorization": "Bearer unit-test-api-token"},
        )

    def request_json_with_headers(
        self,
        base_url: str,
        path: str,
        body: dict,
        headers: dict[str, str],
    ) -> tuple[int, dict]:
        request = Request(
            base_url + path,
            data=json.dumps(body, ensure_ascii=False).encode("utf-8"),
            method="POST",
            headers={
                "Content-Type": "application/json",
                **headers,
            },
        )
        try:
            response = urlopen(request, timeout=3)
        except HTTPError as error:
            return error.code, json.loads(error.read().decode("utf-8"))
        with response:
            return response.status, json.loads(response.read().decode("utf-8"))

    def raw_http_get(self, base_url: str, request_target: str) -> tuple[int, bytes]:
        parsed = urlparse(base_url)
        connection = HTTPConnection(parsed.hostname, parsed.port, timeout=3)
        try:
            connection.request("GET", request_target)
            response = connection.getresponse()
            return response.status, response.read()
        finally:
            connection.close()

    def test_artifact_id_is_signed_tamper_resistant_and_public_record_has_no_path(self) -> None:
        target = self.make_file("uploads/2026-07-13/茶铺 场景.png", b"fake-png")

        artifact = server.artifact_record_for_path(target)

        self.assertNotIn("茶铺", artifact["id"])
        self.assertNotIn("/", artifact["id"])
        self.assertEqual(server.output_target_from_artifact_id(artifact["id"]), target.resolve())
        self.assertNotIn("path", artifact)
        self.assertNotIn(str(self.root), json.dumps(artifact, ensure_ascii=False))
        self.assertEqual(artifact["previewUrl"], "/output/uploads/2026-07-13/%E8%8C%B6%E9%93%BA%20%E5%9C%BA%E6%99%AF.png")

        tampered = artifact["id"][:-1] + ("0" if artifact["id"][-1] != "0" else "1")
        with self.assertRaises(server.UploadError) as raised:
            server.output_target_from_artifact_id(tampered)
        self.assertEqual(raised.exception.status, 404)

        traversal_id = server.artifact_id_for_relative("../outside.png")
        with self.assertRaises(server.UploadError) as traversal:
            server.output_target_from_artifact_id(traversal_id)
        self.assertEqual(traversal.exception.status, 404)

    def test_download_supports_chinese_filename_content_disposition_and_range(self) -> None:
        payload = b"0123456789abcdef"
        target = self.make_file("videos/茶铺 场景.mp4", payload)
        artifact_id = server.artifact_record_for_path(target)["id"]

        with self.http_server() as base_url:
            request = Request(
                f"{base_url}/api/files/download/{quote(artifact_id)}",
                headers={"Range": "bytes=2-7"},
            )
            with urlopen(request, timeout=3) as response:
                self.assertEqual(response.status, 206)
                self.assertEqual(response.read(), payload[2:8])
                self.assertEqual(response.headers["Content-Range"], "bytes 2-7/16")
                disposition = response.headers["Content-Disposition"]
                self.assertIn("attachment", disposition)
                self.assertIn("filename*=UTF-8''", disposition)
                self.assertIn("%E8%8C%B6%E9%93%BA%20%E5%9C%BA%E6%99%AF.mp4", disposition)

    def test_batch_export_zip_is_async_downloadable_and_contains_no_absolute_paths(self) -> None:
        first = self.make_file("one/片段.mp4", b"first")
        second = self.make_file("two/片段.mp4", b"second")
        ids = [
            server.artifact_record_for_path(first)["id"],
            server.artifact_record_for_path(second)["id"],
        ]

        queued = server.create_export_job({"fileIds": ids, "archiveName": "项目 导出.zip"})
        self.assertEqual(queued["archiveName"], "项目 导出.zip")
        deadline = time.monotonic() + 5
        result = queued
        while time.monotonic() < deadline:
            result = server.get_export_job(queued["id"])
            if result["status"] in {"success", "error"}:
                break
            time.sleep(0.02)

        self.assertEqual(result["status"], "success", result.get("error"))
        self.assertEqual(result["progress"], 100)
        self.assertNotIn(str(self.root), json.dumps(result, ensure_ascii=False))
        self.assertNotIn("path", result["file"])
        archive_path = server.output_target_from_artifact_id(result["file"]["id"])
        self.assertEqual(result["file"]["name"], "项目 导出.zip")
        self.assertEqual(archive_path.name, "项目 导出.zip")
        with zipfile.ZipFile(archive_path) as archive:
            self.assertEqual(archive.namelist(), ["片段.mp4", "片段-2.mp4"])
            self.assertTrue(all(item.compress_type == zipfile.ZIP_STORED for item in archive.infolist()))
            self.assertEqual(archive.read("片段.mp4"), b"first")
            self.assertEqual(archive.read("片段-2.mp4"), b"second")

    def test_v2_operations_enforce_cas_return_409_and_replay_request_id_idempotently(self) -> None:
        self.seed_project(revision=7)
        first_body = {
            "baseRevision": 7,
            "requestId": "request-rename-001",
            "operations": [{"type": "rename_canvas", "name": "新版画布"}],
        }

        with self.http_server() as base_url:
            status, first = self.request_json(base_url, "/api/v2/canvases/canvas_main/operations", first_body)
            self.assertEqual(status, 200)
            self.assertEqual(first["revision"], 8)

            replay_status, replay = self.request_json(
                base_url, "/api/v2/canvases/canvas_main/operations", first_body
            )
            self.assertEqual(replay_status, 200)
            self.assertEqual(replay, first)
            self.assertEqual(server.read_project_record()["revision"], 8)

            stale_status, stale = self.request_json(
                base_url,
                "/api/v2/canvases/canvas_main/operations",
                {
                    "baseRevision": 7,
                    "requestId": "request-rename-002",
                    "operations": [{"type": "rename_canvas", "name": "不应覆盖"}],
                },
            )
            self.assertEqual(stale_status, 409)
            self.assertEqual(stale["error"]["code"], "revision_conflict")
            self.assertEqual(stale["revision"], 8)

        record = server.read_project_record()
        self.assertEqual(record["project"]["canvases"][0]["name"], "新版画布")

    def test_v2_canvas_and_artifact_results_never_expose_absolute_paths(self) -> None:
        self.seed_project(revision=2)
        media = self.make_file("images/人物参考.png", b"image")

        canvas = server.canvas_v2("canvas_main", {})
        artifact = server.artifact_record_for_path(media)
        encoded = json.dumps({"canvas": canvas, "artifact": artifact}, ensure_ascii=False)

        self.assertNotIn(str(self.root), encoded)
        self.assertNotIn('"path"', encoded)
        self.assertIn("downloadUrl", artifact)
        self.assertIn("previewUrl", artifact)

    def test_browser_session_cookie_and_csrf_allow_write_but_missing_or_wrong_csrf_are_401(self) -> None:
        self.seed_project(revision=1)
        body = {
            "baseRevision": 1,
            "requestId": "browser-write-001",
            "operations": [{"type": "rename_canvas", "name": "浏览器会话画布"}],
        }

        with self.http_server() as base_url:
            session_request = Request(
                base_url + "/api/browser/session",
                headers={"Origin": base_url, "Sec-Fetch-Site": "same-origin"},
            )
            with urlopen(session_request, timeout=3) as response:
                self.assertEqual(response.status, 200)
                session = json.loads(response.read().decode("utf-8"))
                cookie = response.headers["Set-Cookie"].split(";", 1)[0]

            common = {"Cookie": cookie, "Origin": base_url, "Sec-Fetch-Site": "same-origin"}
            missing_status, _ = self.request_json_with_headers(
                base_url,
                "/api/v2/canvases/canvas_main/operations",
                body,
                common,
            )
            self.assertEqual(missing_status, 401)

            wrong_status, _ = self.request_json_with_headers(
                base_url,
                "/api/v2/canvases/canvas_main/operations",
                body,
                {**common, "X-SelfCanvas-CSRF": "wrong-csrf-token"},
            )
            self.assertEqual(wrong_status, 401)

            valid_status, result = self.request_json_with_headers(
                base_url,
                "/api/v2/canvases/canvas_main/operations",
                body,
                {**common, "X-SelfCanvas-CSRF": session["csrfToken"]},
            )
            self.assertEqual(valid_status, 200)
            self.assertEqual(result["revision"], 2)

        self.assertEqual(server.read_project_record()["project"]["canvases"][0]["name"], "浏览器会话画布")

    def test_prepare_download_only_allows_artifacts_referenced_by_requested_canvas(self) -> None:
        current_file = self.make_file("canvas-main/当前画布.png", b"current")
        other_file = self.make_file("canvas-other/其他画布.png", b"other")
        orphan_file = self.make_file("orphan/仅输出目录.png", b"orphan")
        current = server.artifact_record_for_path(current_file)
        other = server.artifact_record_for_path(other_file)
        orphan = server.artifact_record_for_path(orphan_file)

        project = sample_project()
        project["canvases"][0]["nodes"][0]["data"]["outputs"] = {"artifact": current}
        project["canvases"].append(
            {
                "id": "canvas_other",
                "name": "其他画布",
                "updatedAt": "2026-07-13T00:00:00+00:00",
                "nodes": [
                    {
                        "id": "node_other",
                        "type": "studioNode",
                        "position": {"x": 0, "y": 0},
                        "data": {"kind": "image", "title": "其他", "outputs": {"artifact": other}},
                    }
                ],
                "edges": [],
                "groups": [],
                "viewport": {"x": 0, "y": 0, "zoom": 1},
            }
        )
        server.write_json_atomic(
            server.PROJECT_STATE_PATH,
            {"schemaVersion": 1, "revision": 3, "savedAt": server.now_iso(), "project": project},
        )

        with self.http_server() as base_url:
            allowed_status, allowed = self.request_json(
                base_url,
                "/api/v2/downloads",
                {
                    "canvasId": "canvas_main",
                    "artifactIds": [current["id"]],
                    "requestId": "download-current-001",
                },
            )
            self.assertEqual(allowed_status, 202)
            self.assertEqual(allowed["status"], "ready")

            cross_status, cross = self.request_json(
                base_url,
                "/api/v2/downloads",
                {
                    "canvasId": "canvas_main",
                    "artifactIds": [other["id"]],
                    "requestId": "download-cross-001",
                },
            )
            self.assertEqual(cross_status, 403)
            self.assertIn("该画布", cross["error"])

            orphan_status, orphan_result = self.request_json(
                base_url,
                "/api/v2/downloads",
                {
                    "canvasId": "canvas_main",
                    "artifactIds": [orphan["id"]],
                    "requestId": "download-orphan-001",
                },
            )
            self.assertEqual(orphan_status, 403)
            self.assertIn("该画布", orphan_result["error"])

    def test_svg_upload_is_rejected_and_existing_svg_output_is_forced_attachment(self) -> None:
        svg = b'<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'
        existing = self.make_file("legacy/旧素材.svg", svg)

        with self.http_server() as base_url:
            upload = Request(
                base_url + "/api/files/upload",
                data=svg,
                method="POST",
                headers={
                    "Authorization": "Bearer unit-test-api-token",
                    "Content-Type": "image/svg+xml",
                    "X-File-Name": quote("恶意素材.svg"),
                },
            )
            with self.assertRaises(HTTPError) as rejected:
                urlopen(upload, timeout=3)
            self.assertEqual(rejected.exception.code, 415)

            with urlopen(base_url + "/output/legacy/%E6%97%A7%E7%B4%A0%E6%9D%90.svg", timeout=3) as response:
                self.assertEqual(response.status, 200)
                self.assertEqual(response.read(), svg)
                self.assertIn("attachment", response.headers["Content-Disposition"])
                self.assertIn("filename*=UTF-8''", response.headers["Content-Disposition"])
                self.assertEqual(response.headers["Content-Security-Policy"], "sandbox")
                self.assertEqual(response.headers["X-Content-Type-Options"], "nosniff")
                self.assertEqual(existing.name, "旧素材.svg")

    def test_http_upload_download_and_zip_preserve_original_filename_without_token_leakage(self) -> None:
        original_name = "茶铺 场景（最终）.png"
        payload = b"\x89PNG\r\n\x1a\nselfcanvas-test-image"

        with self.http_server() as base_url:
            upload_request = Request(
                base_url + "/api/files/upload",
                data=payload,
                method="POST",
                headers={
                    "Authorization": "Bearer unit-test-api-token",
                    "Content-Type": "image/png",
                    "X-File-Name": quote(original_name),
                },
            )
            with urlopen(upload_request, timeout=3) as response:
                self.assertEqual(response.status, 201)
                uploaded = json.loads(response.read().decode("utf-8"))

            artifact = uploaded["artifact"]
            self.assertEqual(uploaded["name"], original_name)
            self.assertEqual(artifact["name"], original_name)
            self.assertEqual(artifact["title"], original_name)
            self.assertNotRegex(uploaded["name"], r"[0-9a-f]{32}")
            self.assertNotRegex(artifact["name"], r"[0-9a-f]{32}")
            self.assertNotIn(str(self.output), json.dumps(uploaded, ensure_ascii=False))

            stored_files = list((self.output / "uploads").glob("*/*/*.png"))
            self.assertEqual(len(stored_files), 1)
            stored = stored_files[0]
            storage_token = stored.parent.name
            self.assertRegex(storage_token, r"^[0-9a-f]{32}$")
            self.assertEqual(stored.name, original_name)
            self.assertNotIn(storage_token, artifact["name"])
            self.assertNotIn(storage_token, artifact["downloadUrl"])

            with urlopen(base_url + artifact["downloadUrl"], timeout=3) as response:
                self.assertEqual(response.status, 200)
                self.assertEqual(response.read(), payload)
                disposition = response.headers["Content-Disposition"]
                self.assertIn("attachment", disposition)
                self.assertIn(f"filename*=UTF-8''{quote(original_name)}", disposition)
                self.assertNotIn(storage_token, disposition)

            export_status, export = self.request_json(
                base_url,
                "/api/exports",
                {"fileIds": [artifact["id"]], "archiveName": "上传素材.zip"},
            )
            self.assertEqual(export_status, 202)
            deadline = time.monotonic() + 5
            while time.monotonic() < deadline:
                with urlopen(base_url + f"/api/exports/{export['id']}", timeout=3) as response:
                    export = json.loads(response.read().decode("utf-8"))
                if export["status"] in {"success", "error"}:
                    break
                time.sleep(0.02)
            self.assertEqual(export["status"], "success", export.get("error"))

            with urlopen(base_url + export["downloadUrl"], timeout=3) as response:
                archive_bytes = response.read()
            with zipfile.ZipFile(io.BytesIO(archive_bytes)) as archive:
                self.assertEqual(archive.namelist(), [original_name])
                self.assertEqual(archive.read(original_name), payload)
                self.assertNotIn(storage_token, "\n".join(archive.namelist()))

    def test_static_routes_cannot_escape_dist_into_prefix_named_sibling(self) -> None:
        web_root = self.root / "web"
        dist = web_root / "dist"
        sibling = web_root / "dist-backup"
        dist.mkdir(parents=True)
        sibling.mkdir(parents=True)
        index_body = b"SAFE SELFCANVAS INDEX"
        secret_body = b"SIBLING SECRET MUST NEVER LEAK"
        (dist / "index.html").write_bytes(index_body)
        (sibling / "secret.txt").write_bytes(secret_body)

        with mock.patch.object(server, "DIST_DIR", dist):
            with self.http_server() as base_url:
                for request_target in (
                    "/../dist-backup/secret.txt",
                    "/%2e%2e/dist-backup/secret.txt",
                    "/%2E%2E%2Fdist-backup%2Fsecret.txt",
                ):
                    with self.subTest(request_target=request_target):
                        status, body = self.raw_http_get(base_url, request_target)
                        self.assertIn(status, {200, 404})
                        self.assertNotIn(secret_body, body)
                        if status == 200:
                            self.assertEqual(body, index_body)

    def test_create_export_rejects_source_total_over_limit_with_413(self) -> None:
        source = self.make_file("limits/large.mp4", b"12")
        artifact_id = server.artifact_record_for_path(source)["id"]

        with (
            mock.patch.object(server, "export_size_limit_bytes", return_value=1),
            mock.patch.object(server.EXPORT_EXECUTOR, "submit") as submit,
        ):
            with self.assertRaises(server.UploadError) as rejected:
                server.create_export_job({"fileIds": [artifact_id]})

        self.assertEqual(rejected.exception.status, 413)
        submit.assert_not_called()
        self.assertEqual(server.EXPORT_JOBS, {})

    def test_create_export_rejects_insufficient_disk_space_with_507(self) -> None:
        source = self.make_file("limits/disk.mp4", b"video")
        artifact_id = server.artifact_record_for_path(source)["id"]

        with (
            mock.patch.object(server, "export_size_limit_bytes", return_value=1024 * 1024),
            mock.patch.object(server.shutil, "disk_usage", return_value=mock.Mock(free=0)),
            mock.patch.object(server.EXPORT_EXECUTOR, "submit") as submit,
        ):
            with self.assertRaises(server.UploadError) as rejected:
                server.create_export_job({"fileIds": [artifact_id]})

        self.assertEqual(rejected.exception.status, 507)
        submit.assert_not_called()
        self.assertEqual(server.EXPORT_JOBS, {})

    def test_create_export_applies_queue_backpressure_with_429(self) -> None:
        source = self.make_file("limits/queued.mp4", b"video")
        artifact_id = server.artifact_record_for_path(source)["id"]
        with server.EXPORT_JOBS_LOCK:
            server.EXPORT_JOBS["export_existing"] = {"id": "export_existing", "status": "queued"}

        with (
            mock.patch.dict(os.environ, {"SELF_CANVAS_MAX_EXPORT_QUEUE": "1"}),
            mock.patch.object(server, "ensure_export_capacity", return_value=len(b"video")),
            mock.patch.object(server.EXPORT_EXECUTOR, "submit") as submit,
        ):
            with self.assertRaises(server.UploadError) as rejected:
                server.create_export_job({"fileIds": [artifact_id]})

        self.assertEqual(rejected.exception.status, 429)
        submit.assert_not_called()
        self.assertEqual(set(server.EXPORT_JOBS), {"export_existing"})

    def test_export_write_failure_removes_partial_export_directory(self) -> None:
        source = self.make_file("zip/source.mp4", b"source")
        artifact_id = server.artifact_record_for_path(source)["id"]
        export_id = "export_failure_cleanup"
        with server.EXPORT_JOBS_LOCK:
            server.EXPORT_JOBS[export_id] = {
                "id": export_id,
                "status": "queued",
                "progress": 0,
                "archiveName": "失败测试.zip",
            }

        with (
            mock.patch.object(server, "ensure_export_capacity", return_value=source.stat().st_size),
            mock.patch.object(zipfile.ZipFile, "write", side_effect=OSError("simulated zip write failure")),
        ):
            server.run_export_job(export_id, [artifact_id], "失败测试.zip")

        export_dir = self.output / "exports" / export_id
        self.assertFalse(export_dir.exists())
        job = server.get_export_job(export_id)
        self.assertEqual(job["status"], "error")
        self.assertEqual(job["progress"], 0)
        self.assertIn("simulated zip write failure", job["error"])

    def test_canceling_queued_job_immediately_projects_canceled_state_to_managed_node(self) -> None:
        job_id = "job_cancel_queued_001"
        project = sample_project()
        node_data = project["canvases"][0]["nodes"][0]["data"]
        node_data.update(
            {
                "status": "running",
                "progress": 12,
                "lastJobId": job_id,
                "outputs": {"stale": True},
                "error": "",
            }
        )
        server.write_json_atomic(
            server.PROJECT_STATE_PATH,
            {"schemaVersion": 1, "revision": 4, "savedAt": server.now_iso(), "project": project},
        )
        server.track_managed_job({"id": job_id}, "canvas_main", "node_image")

        with mock.patch.object(server, "run_queue", return_value={"ok": True}) as cancel_runner:
            result = server.cancel_any_job(job_id)

        cancel_runner.assert_called_once_with("cancel", job_id, timeout=8)
        self.assertEqual(result["status"], "canceled")
        self.assertEqual(result["id"], job_id)
        record = server.read_project_record()
        self.assertEqual(record["revision"], 5)
        projected = record["project"]["canvases"][0]["nodes"][0]["data"]
        self.assertEqual(projected["status"], "error")
        self.assertEqual(projected["progress"], 0)
        self.assertEqual(projected["error"], "任务已取消")
        self.assertFalse(server.read_json_file(server.MANAGED_JOBS_PATH, {}))


if __name__ == "__main__":
    unittest.main()
