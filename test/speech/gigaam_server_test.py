"""Exercise long audio coverage and the bounded HTTP API using real tensor operations.

Run with the GigaAM Python environment: python test/speech/gigaam_server_test.py.
Model weights and a GPU are not needed for these contract tests.
"""
import importlib.util
import json
import threading
import unittest
import urllib.error
import urllib.request
from http.server import HTTPServer
from pathlib import Path
from unittest.mock import patch

import torch

spec = importlib.util.spec_from_file_location(
    "gigaam_server", Path(__file__).resolve().parents[2] / "scripts/gigaam-server.py"
)
server = importlib.util.module_from_spec(spec)
spec.loader.exec_module(server)


class SegmentationTests(unittest.TestCase):
    def test_long_recording_preserves_every_sample_in_order(self):
        audio = torch.arange(61 * 16000, dtype=torch.float32)
        chunks = list(server.audio_segments(audio))
        self.assertGreater(len(chunks), 2)
        self.assertTrue(all(chunk.numel() <= 24 * 16000 for chunk in chunks))
        self.assertTrue(torch.equal(torch.cat(chunks), audio))

    def test_cut_prefers_quiet_region(self):
        audio = torch.ones(40 * 16000)
        audio[19 * 16000:20 * 16000] = 0
        chunks = list(server.audio_segments(audio))
        self.assertTrue(19 * 16000 <= chunks[0].numel() < 20 * 16000)

    def test_short_and_empty_audio(self):
        self.assertEqual(list(server.audio_segments(torch.empty(0))), [])
        audio = torch.ones(16000)
        self.assertTrue(torch.equal(list(server.audio_segments(audio))[0], audio))


class HttpTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.http = HTTPServer(("127.0.0.1", 0), server.handler_for(None, "cpu"))
        cls.url = f"http://127.0.0.1:{cls.http.server_port}"
        cls.worker = threading.Thread(target=cls.http.serve_forever)
        cls.worker.start()

    @classmethod
    def tearDownClass(cls):
        cls.http.shutdown()
        cls.worker.join()
        cls.http.server_close()

    def test_health_identifies_backend(self):
        with urllib.request.urlopen(self.url + "/health") as response:
            self.assertEqual(json.load(response), {
                "status": "ok", "backend": "gigaam", "device": "cpu"
            })

    def test_empty_upload_is_rejected(self):
        request = urllib.request.Request(self.url + "/inference", data=b"")
        with self.assertRaises(urllib.error.HTTPError) as caught:
            urllib.request.urlopen(request)
        self.assertEqual(caught.exception.code, 413)

    def test_oversized_upload_is_rejected_before_reading(self):
        request = urllib.request.Request(self.url + "/inference", data=b"",
                                        headers={"Content-Length": str(30 * 1024 * 1024)})
        with self.assertRaises(urllib.error.HTTPError) as caught:
            urllib.request.urlopen(request)
        self.assertEqual(caught.exception.code, 413)

    def test_multipart_upload_preserves_unicode_and_newlines(self):
        body = (b"--test\r\nContent-Disposition: form-data; name=\"file\"; "
                b"filename=\"voice.ogg\"\r\n\r\nogg\r\n--test--\r\n")
        request = urllib.request.Request(self.url + "/inference", data=body,
                                        headers={"Content-Type": "multipart/form-data; boundary=test"})
        class Wave:
            def __enter__(self): return self
            def __exit__(self, *args): pass
            def getnframes(self): return 16000
        with patch.object(server.subprocess, "run"), \
             patch.object(server.wave, "open", return_value=Wave()), \
             patch.object(server, "transcribe", return_value="Привет!\nКак дела?"):
            with urllib.request.urlopen(request) as response:
                self.assertEqual(json.load(response), {"text": "Привет!\nКак дела?"})


if __name__ == "__main__":
    unittest.main()
