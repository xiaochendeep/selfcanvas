from __future__ import annotations

import copy
import io
import json
import os
import tempfile
import threading
import unittest
from http.client import HTTPConnection
from pathlib import Path
from unittest import mock
from urllib.error import HTTPError
from urllib.request import Request, urlopen

import creative_runtime as creative
import server


def request(kind="script", **patch):
    return {"kind": kind, "requestId": "creative-test-001", "canvasId": "canvas_main", "confirmed": True, "brief": "雨夜有人推开茶铺木门", "shotCount": 2, "imageModel": "gpt-image-2", "videoModel": "seedance-2.5", **patch}


def draft(kind="script"):
    result = creative.shape_for(kind)
    if kind == "script":
        result["beats"][0]["durationSeconds"] = 30
    if kind == "storyboard":
        result["shotCount"] = 2
        result["shots"] = [dict(result["shots"][0], shotNumber=index, durationSeconds=15) for index in (1, 2)]
    return result


def config_env():
    return {"SELF_CANVAS_CREATIVE_BASE_URL": "http://127.0.0.1:9876", "SELF_CANVAS_CREATIVE_API_KEY": "secret-never-public", "SELF_CANVAS_CREATIVE_TEXT_MODEL": "text-test", "SELF_CANVAS_CREATIVE_VISION_MODEL": "gemini-test", "SELF_CANVAS_CREATIVE_VIDEO_PROTOCOL": "gemini"}


class CreativeRuntimeTest(unittest.TestCase):
    def normalized(self, **patch):
        return creative.validate_request(request(**patch), {"imageModel": {"gpt-image-2"}, "videoModel": {"seedance-2.5"}})

    def test_missing_configuration_explicit_and_secret_free(self):
        caps = creative.capabilities({})
        self.assertFalse(caps["available"])
        self.assertEqual(caps["skills"][0]["status"], "not-configured")
        ready = creative.capabilities(config_env())
        self.assertTrue(ready["available"])
        self.assertNotIn("secret-never-public", json.dumps(ready))
        self.assertNotIn("127.0.0.1", json.dumps(ready))
        self.assertEqual(ready["skills"][2]["protocol"], "gemini")

    def test_configured_model_allowlist_and_gateway_url(self):
        env = {**config_env(), "SELF_CANVAS_CREATIVE_TEXT_MODELS": "second-model"}
        self.assertEqual(creative.gateway_config("script", "second-model", env)["model"], "second-model")
        for endpoint in ("file:///tmp/secret", "https://key:secret@host", "https://host?q=secret", "http://example.com", "http://0.0.0.0", "http://224.0.0.1"):
            with self.subTest(endpoint=endpoint), self.assertRaises(creative.CreativeError):
                creative.checked_endpoint(endpoint)
        self.assertEqual(creative.checked_endpoint("http://192.168.15.185:8788/v1"), "http://192.168.15.185:8788/v1")
        self.assertEqual(creative.checked_endpoint("https://gateway.example/v1"), "https://gateway.example/v1")
        with self.assertRaisesRegex(creative.CreativeError, "允许"):
            creative.gateway_config("script", "unapproved", env)

    def test_malformed_gateway_configs_are_reported_not_crashes(self):
        for endpoint in ("http://[", "http://localhost:broken", "http://localhost:0"):
            with self.subTest(endpoint=endpoint):
                caps = creative.capabilities({**config_env(), "SELF_CANVAS_CREATIVE_BASE_URL": endpoint})
                self.assertFalse(caps["available"])
                self.assertEqual(caps["skills"][0]["status"], "invalid-config")
        env = {**config_env(), "SELF_CANVAS_CREATIVE_BASE_URL": "http://localhost:broken", "SELF_CANVAS_CREATIVE_VISION_BASE_URL": "https://vision.example", "SELF_CANVAS_CREATIVE_VISION_API_KEY": "vision-only"}
        self.assertTrue(creative.capabilities(env)["skills"][2]["available"])

    def test_vision_key_never_inherits_across_origins(self):
        env = {**config_env(), "SELF_CANVAS_CREATIVE_VISION_BASE_URL": "https://different.example"}
        with self.assertRaisesRegex(creative.CreativeError, "其他主机"):
            creative.gateway_config("video-analysis", env=env)
        self.assertEqual(creative.gateway_config("video-analysis", env={**env, "SELF_CANVAS_CREATIVE_VISION_API_KEY": "vision-only"})["apiKey"], "vision-only")
        self.assertEqual(creative.gateway_config("video-analysis", env={**env, "SELF_CANVAS_CREATIVE_VISION_ALLOW_ANONYMOUS": "true"})["apiKey"], "")
        self.assertEqual(creative.gateway_config("video-analysis", env=config_env())["apiKey"], "secret-never-public")

    def test_request_bounds_confirmation_and_forbidden_fields(self):
        for patch in ({"confirmed": False}, {"endpoint": "https://evil"}, {"apiKey": "evil"}, {"url": "file:///etc/passwd"}, {"sourceText": "x" * 40001}, {"shotCount": 21}, {"shotCount": True}, {"durationSeconds": 601}, {"imageModel": "invented-model"}, {"kind": {}}, {"aspectRatio": {}}):
            with self.subTest(patch=str(patch)[:100]), self.assertRaises(creative.CreativeError):
                self.normalized(**patch)
        self.assertEqual(self.normalized()["shotCount"], 2)

    def test_video_analysis_requires_one_controlled_reference(self):
        for patch in ({}, {"sourceNodeId": "video-node", "artifactId": "file-id"}):
            with self.assertRaises(creative.CreativeError):
                self.normalized(kind="video-analysis", **patch)
        self.assertEqual(self.normalized(kind="video-analysis", sourceNodeId="video-node")["sourceNodeId"], "video-node")

    def test_draft_contract_all_three_kinds(self):
        for kind in creative.KINDS:
            req = self.normalized(kind=kind, **({"sourceNodeId": "video"} if kind == "video-analysis" else {}))
            result = creative.validate_draft(json.dumps(draft(kind)), req, 4)
            self.assertEqual(result["kind"], kind)
        result = creative.validate_draft(json.dumps({**draft(), "operations": [{"delete": "all"}], "apiKey": "evil"}), self.normalized())
        self.assertNotIn("operations", result)
        self.assertNotIn("apiKey", result)

    def test_storyboard_requires_direction_and_count(self):
        req = self.normalized(kind="storyboard")
        invalid = draft("storyboard")
        del invalid["shots"][0]["environmentPressure"]
        with self.assertRaisesRegex(creative.CreativeError, "environmentPressure"):
            creative.validate_draft(json.dumps(invalid), req)
        invalid = draft("storyboard")
        invalid["shots"][0]["shotNumber"] = True
        with self.assertRaises(creative.CreativeError):
            creative.validate_draft(json.dumps(invalid), req)
        invalid = draft("storyboard")
        invalid["shots"].pop()
        with self.assertRaisesRegex(creative.CreativeError, "数量"):
            creative.validate_draft(json.dumps(invalid), req)

    def test_exact_total_duration_and_model_clip_duration(self):
        req = self.normalized(kind="storyboard")
        invalid = draft("storyboard")
        invalid["shots"][0]["durationSeconds"] = 180
        with self.assertRaisesRegex(creative.CreativeError, "总时长"):
            creative.validate_draft(json.dumps(invalid), req)
        invalid = draft()
        invalid["beats"][0]["durationSeconds"] = 5
        with self.assertRaisesRegex(creative.CreativeError, "总时长"):
            creative.validate_draft(json.dumps(invalid), self.normalized())
        context = {"videoModel": {"durations": [5, 10]}}
        with self.assertRaisesRegex(creative.CreativeError, "所选视频模型"):
            creative.validate_draft(json.dumps(draft("storyboard")), req, model_context=context)
        with self.assertRaisesRegex(creative.CreativeError, "未调用模型"):
            creative.validate_target_timing(req, context)

    def test_model_numeric_nan_bool_and_inf_fail(self):
        for bad in (True, float("nan"), float("inf"), 10 ** 999):
            invalid = draft()
            invalid["beats"][0]["durationSeconds"] = bad
            with self.assertRaises(creative.CreativeError):
                creative.validate_draft(json.dumps(invalid), self.normalized())
            with self.assertRaises(creative.CreativeError):
                self.normalized(durationSeconds=bad)

    def test_analysis_prompt_uses_source_duration_not_creation_shot_count(self):
        normalized = self.normalized(kind="video-analysis", sourceNodeId="video")
        prompt = creative.build_system_prompt(Path(server.ROOT), normalized, {})
        self.assertIn("sourceVideo.durationSeconds", prompt)
        self.assertNotIn("分镜要求：严格", prompt)
        self.assertNotIn("总目标时长 30 秒", prompt)

    def test_deeply_nested_response_is_invalid_draft(self):
        with self.assertRaises(creative.CreativeError) as error:
            creative.validate_draft("[" * 2000 + "0" + "]" * 2000, self.normalized())
        self.assertEqual(error.exception.code, "invalid_draft")

    def test_analysis_requires_evidence_timestamps_and_confidence(self):
        req = self.normalized(kind="video-analysis", sourceNodeId="video")
        invalid = draft("video-analysis")
        with self.assertRaisesRegex(creative.CreativeError, "数值"):
            creative.validate_draft(json.dumps(invalid), req, 2)
        invalid["segments"][0]["confidence"] = "high"
        with self.assertRaises(creative.CreativeError):
            creative.validate_draft(json.dumps(invalid), req, 4)

    def test_oversized_empty_and_unprobeable_video_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "clip.mp4"
            path.write_bytes(b"")
            with self.assertRaises(creative.CreativeError):
                creative.inspect_video(path)
            with path.open("wb") as stream:
                stream.truncate(creative.MAX_VIDEO_BYTES + 1)
            with self.assertRaisesRegex(creative.CreativeError, "14 MiB"):
                creative.inspect_video(path)
            path.write_bytes(b"not a video")
            with mock.patch.object(creative.shutil, "which", return_value=None), self.assertRaisesRegex(creative.CreativeError, "ffprobe"):
                creative.inspect_video(path)
            with mock.patch.object(creative.shutil, "which", return_value="ffprobe"), mock.patch.object(creative.subprocess, "run", return_value=mock.Mock(returncode=1, stdout=b"{}")):
                with self.assertRaisesRegex(creative.CreativeError, "不是可读取"):
                    creative.inspect_video(path)

    def test_gateway_openai_payload_and_no_endpoint_leaks(self):
        captured = []
        response = {"choices": [{"message": {"content": json.dumps(draft())}}]}
        def fake_open(req, timeout):
            captured.append((req, timeout))
            return io.BytesIO(json.dumps(response).encode())
        config = creative.gateway_config("script", env=config_env())
        with mock.patch.object(creative, "build_opener", return_value=mock.Mock(open=fake_open)):
            text = creative.gateway_request(config, "system rules", self.normalized())
        self.assertEqual(json.loads(text)["kind"], "script")
        req, timeout = captured[0]
        payload = json.loads(req.data)
        self.assertEqual(req.full_url, "http://127.0.0.1:9876/v1/chat/completions")
        self.assertEqual(payload["model"], "text-test")
        self.assertEqual(timeout, 90)
        with mock.patch.object(creative, "build_opener", return_value=mock.Mock(open=mock.Mock(side_effect=HTTPError("https://secret", 401, "apiKey=secret", {}, None)))):
            with self.assertRaisesRegex(creative.CreativeError, "HTTP 401") as error:
                creative.gateway_request(config, "rules", self.normalized())
            self.assertNotIn("secret", str(error.exception))

    def test_gateway_timeout_and_response_limits_do_not_retry(self):
        config = creative.gateway_config("script", env=config_env())
        fail = mock.Mock(side_effect=TimeoutError("secret upstream"))
        with mock.patch.object(creative, "build_opener", return_value=mock.Mock(open=fail)):
            with self.assertRaises(creative.CreativeError) as error:
                creative.gateway_request(config, "rules", self.normalized())
        self.assertEqual(error.exception.status, 504)
        self.assertEqual(fail.call_count, 1)
        huge = io.BytesIO(b"x" * (creative.MAX_RESPONSE_BYTES + 1))
        with mock.patch.object(creative, "build_opener", return_value=mock.Mock(open=mock.Mock(return_value=huge))):
            with self.assertRaisesRegex(creative.CreativeError, "响应过大"):
                creative.gateway_request(config, "rules", self.normalized())

    def test_slow_dripping_response_obeys_elapsed_deadline(self):
        current = [0.0]
        class SlowBody:
            def read(self, amount):
                raise AssertionError("read would block waiting for the complete body")
            def read1(self, amount):
                current[0] += 4
                return b"x"
        with mock.patch.object(creative.time, "monotonic", side_effect=lambda: current[0]):
            with self.assertRaises(TimeoutError):
                creative.read_gateway_response(SlowBody(), 5)
        self.assertEqual(current[0], 8)

    def test_malformed_gateway_content_is_sanitized_502(self):
        for protocol, payload in (("openai", {"choices": [{"message": {"content": [None]}}]}), ("gemini", {"candidates": [{"content": {"parts": ["invalid"]}}]})):
            config = {**creative.gateway_config("script", env=config_env()), "protocol": protocol}
            with mock.patch.object(creative, "build_opener", return_value=mock.Mock(open=mock.Mock(return_value=io.BytesIO(json.dumps(payload).encode())))):
                with self.assertRaises(creative.CreativeError) as error:
                    creative.gateway_request(config, "rules", self.normalized())
            self.assertEqual(error.exception.status, 502)
            self.assertEqual(error.exception.code, "invalid_response")

    def test_gemini_receives_real_inline_bytes(self):
        captured = []
        response = {"candidates": [{"content": {"parts": [{"text": json.dumps(draft("video-analysis"))}]}}]}
        def fake_open(req, timeout):
            captured.append(req)
            return io.BytesIO(json.dumps(response).encode())
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "video.mp4"
            path.write_bytes(b"actual video body fixture")
            config = creative.gateway_config("video-analysis", env=config_env())
            req = self.normalized(kind="video-analysis", sourceNodeId="video")
            with mock.patch.object(creative, "build_opener", return_value=mock.Mock(open=fake_open)):
                creative.gateway_request(config, "rules", req, (path, {"mimeType": "video/mp4", "durationSeconds": 5}))
        payload = json.loads(captured[0].data)
        self.assertTrue(captured[0].full_url.endswith("/v1beta/models/gemini-test:generateContent"))
        self.assertEqual(payload["contents"][0]["parts"][1]["inlineData"]["data"], "YWN0dWFsIHZpZGVvIGJvZHkgZml4dHVyZQ==")
        self.assertNotIn(str(path), json.dumps(payload))
        self.assertIsNone(creative.NoRedirect().redirect_request(None, None, 302, "", {}, "https://evil"))


class CreativeServerTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.output = self.root / "output"
        self.output.mkdir()
        self.project_path = self.root / "project.json"
        self.patches = [mock.patch.dict(os.environ, {**config_env(), "SELF_CANVAS_API_TOKEN": "test-api-token", "SELF_CANVAS_ARTIFACT_SECRET": "test-artifact-secret", "SELF_CANVAS_STORAGE_ROOT": str(self.root)}), mock.patch.object(server, "RUNTIME_DIR", self.root), mock.patch.object(server, "PROJECT_STATE_PATH", self.project_path)]
        for patch in self.patches:
            patch.start()
        project = {"id": "project-test", "activeCanvasId": "canvas_main", "canvases": [{"id": "canvas_main", "nodes": [], "edges": []}, {"id": "canvas_other", "nodes": [], "edges": []}]}
        server.write_json_atomic(self.project_path, {"schemaVersion": 1, "revision": 7, "project": project})

    def tearDown(self):
        for patch in reversed(self.patches):
            patch.stop()
        self.temp.cleanup()

    def test_run_is_draft_only_and_duplicate_is_cached(self):
        original = self.project_path.read_bytes()
        with mock.patch.object(creative, "gateway_request", return_value=json.dumps(draft())) as call:
            first = server.create_creative_run(request())
            second = server.create_creative_run(request())
        self.assertEqual(first, second)
        self.assertEqual(call.call_count, 1)
        self.assertEqual(first["sourceRevision"], 7)
        self.assertEqual(first["imageModel"], "gpt-image-2")
        self.assertEqual(original, self.project_path.read_bytes())
        with self.assertRaisesRegex(creative.CreativeError, "不同内容"):
            server.create_creative_run(request(brief="changed"))

    def test_failed_request_never_automatically_repeats(self):
        with mock.patch.object(creative, "gateway_request", side_effect=creative.CreativeError(504, "gateway_timeout", "超时，未自动重试")) as call:
            for _ in range(2):
                with self.assertRaises(creative.CreativeError):
                    server.create_creative_run(request())
        self.assertEqual(call.call_count, 1)

    def test_in_progress_duplicate_no_second_call(self):
        started, release = threading.Event(), threading.Event()
        results = []
        def delayed(*args):
            started.set()
            release.wait(5)
            return json.dumps(draft())
        with mock.patch.object(creative, "gateway_request", side_effect=delayed) as call:
            thread = threading.Thread(target=lambda: results.append(server.create_creative_run(request())))
            thread.start()
            self.assertTrue(started.wait(3))
            try:
                with self.assertRaisesRegex(creative.CreativeError, "正在执行"):
                    server.create_creative_run(request())
            finally:
                release.set()
                thread.join(5)
        self.assertEqual(call.call_count, 1)
        self.assertEqual(len(results), 1)

    def test_corrupt_idempotency_store_fails_closed(self):
        (self.root / "creative-runs.json").write_text("not json")
        with mock.patch.object(creative, "gateway_request") as call, self.assertRaisesRegex(creative.CreativeError, "记录不可用"):
            server.create_creative_run(request())
        call.assert_not_called()

    def test_null_and_malformed_idempotency_entries_cannot_repeat_paid_call(self):
        with mock.patch.object(creative, "gateway_request", return_value=json.dumps(draft())) as call:
            result = server.create_creative_run(request())
            for entry in (None, {}, {"status": "completed", "fingerprint": "a" * 64, "result": {}}):
                server.write_json_atomic(self.root / "creative-runs.json", {result["runId"]: entry})
                with self.assertRaisesRegex(creative.CreativeError, "记录不可用"):
                    server.create_creative_run(request())
        self.assertEqual(call.call_count, 1)

    def test_concurrent_canvas_edit_is_preserved_and_source_revision_is_stable(self):
        def gateway(*args):
            record = server.read_project_record()
            record["revision"] = 8
            record["project"]["canvases"][0]["name"] = "由另一浏览器修改"
            server.write_json_atomic(self.project_path, record)
            return json.dumps(draft())
        with mock.patch.object(creative, "gateway_request", side_effect=gateway):
            result = server.create_creative_run(request())
        self.assertEqual(result["sourceRevision"], 7)
        self.assertEqual(server.read_project_record()["revision"], 8)
        self.assertEqual(server.read_project_record()["project"]["canvases"][0]["name"], "由另一浏览器修改")

    def test_unknown_gateway_model_never_calls_provider(self):
        with mock.patch.object(creative, "gateway_request") as call:
            with self.assertRaisesRegex(creative.CreativeError, "允许"):
                server.create_creative_run(request(model="not-configured-model"))
        call.assert_not_called()

    def test_creative_body_rejects_malformed_oversized_or_unframed_input(self):
        cases = [
            (b"not json", {}, 400),
            (b"[1,2]", {}, 400),
            (b"\xff", {}, 400),
            (b"{}", {"Content-Length": str(creative.MAX_REQUEST_BYTES + 1)}, 413),
            (b"{}", {"Content-Length": "NaN"}, 400),
            (b"{}", {"Content-Length": "-1"}, 400),
            (b"{}", {"Transfer-Encoding": "chunked"}, 400),
            (b"{}", {"Content-Type": "text/plain"}, 415),
            (b"{}", {"Content-Length": "3"}, 400),
        ]
        for raw, patch, expected in cases:
            handler = mock.Mock(headers={"Content-Type": "application/json", "Content-Length": str(len(raw)), **patch}, rfile=io.BytesIO(raw))
            handler.connection.gettimeout.return_value = None
            with self.subTest(case=patch or raw), self.assertRaises(creative.CreativeError) as error:
                server.read_creative_body(handler)
            self.assertEqual(error.exception.status, expected)

    def test_http_malformed_and_large_requests_return_400_413_without_generation(self):
        httpd = server.ThreadingHTTPServer(("127.0.0.1", 0), server.SelfCanvasHandler)
        thread = threading.Thread(target=httpd.serve_forever, daemon=True)
        thread.start()
        try:
            with mock.patch.object(creative, "gateway_request") as call:
                for body, content_length, expected in ((b"not json", 8, 400), (b"{}", creative.MAX_REQUEST_BYTES + 1, 413)):
                    connection = HTTPConnection("127.0.0.1", httpd.server_port, timeout=3)
                    connection.request("POST", "/api/v2/creative/runs", body, {"Authorization": "Bearer test-api-token", "Content-Type": "application/json", "Content-Length": str(content_length)})
                    response = connection.getresponse()
                    self.assertEqual(response.status, expected)
                    response.read()
                    connection.close()
                call.assert_not_called()
        finally:
            httpd.shutdown()
            httpd.server_close()
            thread.join(3)

    def test_video_artifact_must_belong_to_requested_canvas(self):
        clip = self.output / "clip.mp4"
        clip.write_bytes(b"video fixture")
        artifact = server.artifact_record_for_path(clip)
        record = server.read_project_record()
        record["project"]["canvases"][1]["nodes"] = [{"id": "video_other", "data": {"kind": "video", "outputs": {"artifact": artifact, "videoUrl": artifact["previewUrl"]}}}]
        server.write_json_atomic(self.project_path, record)
        with mock.patch.object(creative, "gateway_request") as call, self.assertRaisesRegex(creative.CreativeError, "当前画布"):
            server.create_creative_run(request(kind="video-analysis", artifactId=artifact["id"]))
        call.assert_not_called()
        record["project"]["canvases"][0]["nodes"] = record["project"]["canvases"][1]["nodes"]
        server.write_json_atomic(self.project_path, record)
        with mock.patch.object(creative, "inspect_video", return_value={"mimeType": "video/mp4", "durationSeconds": 5}), mock.patch.object(creative, "gateway_request", return_value=json.dumps(draft("video-analysis"))) as call:
            result = server.create_creative_run(request(kind="video-analysis", sourceNodeId="video_other"))
        self.assertEqual(result["kind"], "video-analysis")
        self.assertEqual(call.call_args.args[3][0], clip.resolve())

    def test_catalog_removal_does_not_prevent_completed_replay(self):
        with mock.patch.object(creative, "gateway_request", return_value=json.dumps(draft())):
            first = server.create_creative_run(request())
        with mock.patch.object(server, "creative_target_models", return_value={}):
            self.assertEqual(server.create_creative_run(request()), first)

    def test_http_authentication_required_on_capabilities_and_runs(self):
        httpd = server.ThreadingHTTPServer(("127.0.0.1", 0), server.SelfCanvasHandler)
        thread = threading.Thread(target=httpd.serve_forever, daemon=True)
        thread.start()
        base = f"http://127.0.0.1:{httpd.server_port}"
        try:
            for path, body in (("/api/v2/creative/capabilities", None), ("/api/v2/creative/runs", request())):
                req = Request(base + path, data=json.dumps(body).encode() if body else None, headers={"Content-Type": "application/json"})
                with self.assertRaises(HTTPError) as error:
                    urlopen(req, timeout=3)
                self.assertEqual(error.exception.code, 401)
            req = Request(base + "/api/v2/creative/capabilities", headers={"Authorization": "Bearer test-api-token"})
            with urlopen(req, timeout=3) as response:
                self.assertTrue(json.load(response)["available"])
            req = Request(base + "/api/v2/creative/runs", data=json.dumps(request(confirmed=False)).encode(), headers={"Authorization": "Bearer test-api-token", "Content-Type": "application/json"})
            with self.assertRaises(HTTPError) as error:
                urlopen(req, timeout=3)
            self.assertEqual(error.exception.code, 400)
        finally:
            httpd.shutdown()
            httpd.server_close()
            thread.join(3)


if __name__ == "__main__":
    unittest.main()
