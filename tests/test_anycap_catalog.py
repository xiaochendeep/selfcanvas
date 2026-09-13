import importlib.util
import tempfile
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("selfcanvas_catalog_server", ROOT / "server.py")
server = importlib.util.module_from_spec(spec)
spec.loader.exec_module(server)


class AnyCapCatalogTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.patch = mock.patch.object(server, "RUNTIME_DIR", Path(self.temp.name))
        self.patch.start()

    def tearDown(self):
        self.patch.stop()
        self.temp.cleanup()

    def test_schema_normalizes_h3_by_selected_mode(self):
        options = server.normalize_video_options("minimax-h3", {
            "mode": "text-to-video", "duration": 4, "resolution": "720p", "aspectRatio": "adaptive", "generateAudio": True,
        })
        self.assertEqual(options["resolution"], "2k")
        self.assertEqual(options["duration"], 5)
        self.assertNotEqual(options["aspectRatio"], "adaptive")
        self.assertNotIn("generateAudio", options)
        self.assertEqual(server.normalize_video_options("seedance-2.5", {"duration": 30})["duration"], 30)
        with self.assertRaisesRegex(RuntimeError, "至少 2"):
            server.validate_video_references("seedance-2.5", [], "first-last-frame-to-video")

    def test_audio_options_are_accepted_and_references_validated_before_enqueue(self):
        options = {"model": "doubao-seed-audio-1-0", "mode": "text-to-audio", "format": "wav", "sampleRate": 48000,
                   "speechRate": 15, "pitchRate": -1, "loudnessRate": 10, "enableSubtitle": True, "speakerIds": ["speaker-one"]}
        self.assertEqual(server.sanitize_options("audio", {"options": options}), options)
        self.assertEqual(server.route_model("audio", "suno-v5-5"), "suno-v5.5")
        with self.assertRaisesRegex(RuntimeError, "1–3"):
            server.normalize_anycap_audio_options("doubao-seed-audio-1-0", {"mode": "audio-to-audio"}, [], "配音")
        with self.assertRaisesRegex(RuntimeError, "speakerIds"):
            server.sanitize_options("audio", {"options": {"speakerIds": ["a", "b"]}})

    def test_offline_scan_keeps_verified_native_audio_music_and_exact_schema(self):
        with mock.patch.object(server, "http_json_request", return_value={"available": False, "payload": {}}):
            payload = server.anycap_capabilities_payload({})
        self.assertEqual(payload["catalogSource"], "bundled")
        self.assertEqual(sum(row["modelCount"] for row in payload["capabilities"]), 28)
        audio = next(row for row in payload["capabilities"] if row["id"] == "audio")
        self.assertEqual(audio["models"][0]["id"], "doubao-seed-audio-1-0")
        h3 = payload["videoCapabilities"]["minimax-h3"]
        self.assertEqual(h3["referenceLimits"], {"image": 9, "video": 3, "audio": 3})
        self.assertFalse(h3["modeOptions"]["multi-modal-reference"]["supportsGenerateAudio"])
        self.assertEqual(payload["audioCapabilities"]["suno-v5.5"]["capability"], "music")


if __name__ == "__main__":
    unittest.main()
