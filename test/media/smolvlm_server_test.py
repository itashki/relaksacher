"""Run with: python3 test/media/smolvlm_server_test.py

Contract tests for scripts/smolvlm-server.py using only the stdlib plus ffmpeg.
No model weights, torch or GPU are needed; inference is replaced by a fake.
"""
import importlib.util
import json
import subprocess
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
from http.server import HTTPServer
from pathlib import Path

spec = importlib.util.spec_from_file_location(
    "smolvlm_server", Path(__file__).resolve().parents[2] / "scripts/smolvlm-server.py"
)
server = importlib.util.module_from_spec(spec)
spec.loader.exec_module(server)

WORKDIR = tempfile.TemporaryDirectory(prefix="smolvlm-test-")
VIDEO = Path(WORKDIR.name) / "clip.mp4"


def setUpModule():
    subprocess.run([
        "ffmpeg", "-nostdin", "-v", "error", "-f", "lavfi",
        "-i", "testsrc=duration=3:size=640x360:rate=10", "-y", str(VIDEO),
    ], check=True)


def tearDownModule():
    WORKDIR.cleanup()


def fake_describe(video_path, prompt):
    duration = server.probe_duration(video_path)
    return {"description": f"fake:{prompt}", "frames": 1, "duration": duration}


def multipart(fields):
    boundary = "xBOUNDARYx"
    body = b""
    for name, value in fields.items():
        body += (f'--{boundary}\r\nContent-Disposition: form-data; name="{name}"; '
                 f'filename="{name}.bin"\r\n\r\n').encode() + value + b"\r\n"
    body += f"--{boundary}--\r\n".encode()
    return body, {"Content-Type": f"multipart/form-data; boundary={boundary}"}


class FrameTests(unittest.TestCase):
    def test_probe_duration(self):
        self.assertAlmostEqual(server.probe_duration(VIDEO), 3.0, delta=0.3)

    def test_probe_rejects_non_video(self):
        bad = Path(WORKDIR.name) / "bad.mp4"
        bad.write_bytes(b"not a video")
        with self.assertRaises(ValueError):
            server.probe_duration(bad)

    def test_sample_frames_ordered_and_bounded(self):
        with tempfile.TemporaryDirectory() as out:
            frames = server.sample_frames(VIDEO, 4, out)
            self.assertTrue(1 <= len(frames) <= 4)
            stamps = [stamp for stamp, _ in frames]
            self.assertEqual(stamps, sorted(stamps))
            for _, png in frames:
                self.assertTrue(Path(png).is_file())
            self.assertEqual(len(frames), 4)


class LazyModelTests(unittest.TestCase):
    """The model loads per job and is always released; no torch needed."""

    def setUp(self):
        self.events = []
        self.dir = tempfile.TemporaryDirectory()
        self.video = str(Path(self.dir.name) / "v.mp4")
        subprocess.run(["ffmpeg", "-nostdin", "-v", "error", "-f", "lavfi", "-i",
                        "testsrc=duration=1:size=64x64:rate=5", "-y", self.video], check=True)
        self.original = server.describe_frames

    def tearDown(self):
        server.describe_frames = self.original
        self.dir.cleanup()

    def make(self, fail=False):
        def fake_frames(bundle, frames, prompt):
            self.events.append("run")
            if fail:
                raise RuntimeError("boom")
            return "text"
        server.describe_frames = fake_frames
        return server.make_describe(
            lambda: (self.events.append("load"), {"m": 1})[1], 2,
            release=lambda bundle: self.events.append("release"))

    def test_nothing_loads_until_a_job_and_each_job_reloads(self):
        describe = self.make()
        self.assertEqual(self.events, [])
        self.assertEqual(describe(self.video, None)["description"], "text")
        describe(self.video, None)
        self.assertEqual(self.events, ["load", "run", "release"] * 2)

    def test_release_runs_after_an_error(self):
        describe = self.make(fail=True)
        with self.assertRaises(RuntimeError):
            describe(self.video, None)
        self.assertEqual(self.events, ["load", "run", "release"])

    def test_undecodable_video_never_loads(self):
        describe = self.make()
        bad = Path(self.dir.name) / "bad.mp4"
        bad.write_bytes(b"nope")
        with self.assertRaises(ValueError):
            describe(str(bad), None)
        self.assertEqual(self.events, [])


class HttpTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.http = HTTPServer(("127.0.0.1", 0), server.handler_for(fake_describe, "cpu"))
        cls.url = f"http://127.0.0.1:{cls.http.server_port}"
        cls.worker = threading.Thread(target=cls.http.serve_forever)
        cls.worker.start()

    @classmethod
    def tearDownClass(cls):
        cls.http.shutdown()
        cls.worker.join()
        cls.http.server_close()

    def post(self, path, body, headers):
        return urllib.request.urlopen(
            urllib.request.Request(self.url + path, data=body, headers=headers)
        )

    def status_of(self, *args):
        with self.assertRaises(urllib.error.HTTPError) as caught:
            self.post(*args)
        return caught.exception.code

    def test_health(self):
        with urllib.request.urlopen(self.url + "/health") as response:
            self.assertEqual(json.load(response), {
                "status": "ok", "backend": "smolvlm", "device": "cpu"
            })

    def test_describe_returns_json(self):
        body, headers = multipart({"file": VIDEO.read_bytes(), "prompt": b"hi"})
        with self.post("/describe", body, headers) as response:
            self.assertEqual(response.status, 200)
            data = json.load(response)
        self.assertEqual(data["description"], "fake:hi")
        self.assertEqual(data["frames"], 1)
        self.assertGreater(data["duration"], 0)

    def test_non_video_is_400(self):
        body, headers = multipart({"file": b"definitely not a video"})
        self.assertEqual(self.status_of("/describe", body, headers), 400)

    def test_oversize_content_length_is_413(self):
        headers = {"Content-Length": str(30 * 1024 * 1024),
                   "Content-Type": "multipart/form-data; boundary=x"}
        self.assertEqual(self.status_of("/describe", b"", headers), 413)

    def test_unknown_path_is_404(self):
        with self.assertRaises(urllib.error.HTTPError) as caught:
            urllib.request.urlopen(self.url + "/nope")
        self.assertEqual(caught.exception.code, 404)
        self.assertEqual(self.status_of("/nope", b"x", {}), 404)


if __name__ == "__main__":
    unittest.main()
