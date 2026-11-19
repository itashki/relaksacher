"""Resident SmolVLM2 video describer with a bounded loopback HTTP API.

Frames are sampled with ffmpeg and passed to the model as ordered images with
timestamps. Weights load from a local directory only (no network at runtime).
torch/transformers are imported lazily so the HTTP contract is testable with
plain python3. API: GET /health; POST /describe (multipart `file`, optional
`prompt`) -> {"description", "frames", "duration"}.
"""
import argparse
import json
import os
import subprocess
import sys
import tempfile
from email.parser import BytesParser
from email.policy import default
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

os.environ.setdefault("HF_HUB_OFFLINE", "1")
os.environ.setdefault("TRANSFORMERS_OFFLINE", "1")

MAX_UPLOAD = 20 * 1024 * 1024
MAX_PROMPT = 1000
FRAME_SIDE = 384
DEFAULT_PROMPT = (
    "Describe this short video in detail: people, actions, setting, visible text. "
    "Do not guess sounds or speech."
)


def probe_duration(path):
    """Return the video duration in seconds as a float.

    Raises ValueError when the file is not a decodable video with a video
    stream and a positive duration.
    """
    try:
        result = subprocess.run([
            "ffprobe", "-v", "error", "-select_streams", "v:0",
            "-show_entries", "stream=codec_type:format=duration",
            "-of", "json", str(path),
        ], check=True, capture_output=True, timeout=30)
        info = json.loads(result.stdout or b"{}")
        if not info.get("streams"):
            raise ValueError("No video stream")
        duration = float(info["format"]["duration"])
    except (subprocess.SubprocessError, KeyError, TypeError, json.JSONDecodeError) as error:
        raise ValueError("Not a valid video") from error
    if not duration > 0:
        raise ValueError("Video has no duration")
    return duration


def sample_frames(path, max_frames, out_dir):
    """Extract up to max_frames evenly spaced PNG frames into out_dir.

    Each frame is scaled so its long side is at most 384 px. Returns an ordered
    list of (timestamp_seconds, png_path) with at least one entry; raises
    ValueError when no frame can be decoded.
    """
    duration = probe_duration(path)
    count = max(1, int(max_frames))
    scale = (f"scale=w='if(gt(iw,ih),min({FRAME_SIDE}\\,iw),-2)':"
             f"h='if(gt(iw,ih),-2,min({FRAME_SIDE}\\,ih))'")
    frames = []
    for index in range(count):
        stamp = duration * (index + 0.5) / count
        target = Path(out_dir) / f"frame-{index:03d}.png"
        try:
            subprocess.run([
                "ffmpeg", "-nostdin", "-v", "error", "-ss", f"{stamp:.3f}", "-i", str(path),
                "-frames:v", "1", "-vf", scale, "-y", str(target),
            ], check=True, capture_output=True, timeout=60)
        except subprocess.SubprocessError as error:
            raise ValueError("Could not decode frames") from error
        if target.is_file() and target.stat().st_size > 0:
            frames.append((stamp, str(target)))
    if not frames:
        raise ValueError("No frames decoded")
    return frames


def load_model(model_dir, device):
    """Load the processor and model from a local directory; return a bundle.

    Imports torch and transformers lazily. `auto` resolves to cuda when
    available. Uses bf16 on CUDA and float32 on CPU, local files only.
    """
    import torch
    from transformers import AutoModelForImageTextToText, AutoProcessor

    if device == "auto":
        device = "cuda" if torch.cuda.is_available() else "cpu"
    dtype = torch.bfloat16 if device == "cuda" else torch.float32
    processor = AutoProcessor.from_pretrained(model_dir, local_files_only=True)
    model = AutoModelForImageTextToText.from_pretrained(
        model_dir, local_files_only=True, torch_dtype=dtype
    ).to(device)
    model.eval()
    return {"processor": processor, "model": model, "device": device, "dtype": dtype}


def describe_frames(bundle, frames, prompt):
    """Describe ordered (timestamp, png_path) frames; return stripped text.

    Builds one user message: each frame as an image preceded by
    "Frame N at T s", then the prompt. Greedy decoding, max 256 new tokens.
    """
    import torch
    from PIL import Image

    content = []
    images = []
    for number, (stamp, png) in enumerate(frames, 1):
        content.append({"type": "text", "text": f"Frame {number} at {stamp:.1f} s"})
        content.append({"type": "image"})
        images.append(Image.open(png).convert("RGB"))
    content.append({"type": "text", "text": prompt or DEFAULT_PROMPT})
    processor, model = bundle["processor"], bundle["model"]
    text = processor.apply_chat_template(
        [{"role": "user", "content": content}], add_generation_prompt=True
    )
    inputs = processor(text=text, images=images, return_tensors="pt").to(model.device)
    inputs = {k: v.to(bundle["dtype"]) if v.is_floating_point() else v for k, v in inputs.items()}
    with torch.inference_mode():
        output = model.generate(**inputs, max_new_tokens=256, do_sample=False)
    generated = output[:, inputs["input_ids"].shape[1]:]
    return processor.batch_decode(generated, skip_special_tokens=True)[0].strip()


def make_describe(bundle, max_frames):
    """Return describe(video_path, prompt) -> dict bound to a loaded model.

    Raises ValueError for undecodable video or an empty description.
    """
    def describe(video_path, prompt):
        duration = probe_duration(video_path)
        with tempfile.TemporaryDirectory(prefix="relaksacher-smolvlm-frames-") as frames_dir:
            frames = sample_frames(video_path, max_frames, frames_dir)
            text = describe_frames(bundle, frames, prompt)
        if not text:
            raise ValueError("Empty description")
        return {"description": text, "frames": len(frames), "duration": duration}

    return describe


def handler_for(describe, device):
    """Build a handler around describe(video_path, prompt) -> dict.

    describe may raise ValueError (reported as 400); any other exception is
    a 500. HTTPServer serializes requests, so inference is single-flight.
    """
    class Handler(BaseHTTPRequestHandler):
        def setup(self):
            super().setup()
            self.connection.settimeout(60)

        def reply(self, status, value):
            data = json.dumps(value, ensure_ascii=False).encode()
            self.send_response(status)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def do_GET(self):
            if self.path != "/health":
                return self.reply(404, {"error": "Not found"})
            self.reply(200, {"status": "ok", "backend": "smolvlm", "device": device})

        def do_POST(self):
            if self.path != "/describe":
                return self.reply(404, {"error": "Not found"})
            try:
                size = int(self.headers.get("Content-Length", "0"))
                if not 0 < size <= MAX_UPLOAD + 65536:
                    self.close_connection = True
                    return self.reply(413, {"error": "Invalid upload size"})
                content_type = self.headers.get("Content-Type", "")
                if not content_type.startswith("multipart/form-data;"):
                    return self.reply(400, {"error": "Expected multipart video"})
                body = self.rfile.read(size)
                if len(body) != size:
                    return self.reply(400, {"error": "Incomplete upload"})
                message = BytesParser(policy=default).parsebytes(
                    f"Content-Type: {content_type}\r\nMIME-Version: 1.0\r\n\r\n".encode() + body
                )
                fields = {}
                for part in message.iter_parts():
                    name = part.get_param("name", header="content-disposition")
                    if name in ("file", "prompt") and name not in fields:
                        fields[name] = part.get_payload(decode=True)
                video = fields.get("file")
                if not video or len(video) > MAX_UPLOAD:
                    return self.reply(400, {"error": "Invalid video"})
                prompt = (fields.get("prompt") or b"").decode("utf-8", "replace").strip()
                if len(prompt) > MAX_PROMPT:
                    return self.reply(400, {"error": "Prompt too long"})
                with tempfile.TemporaryDirectory(prefix="relaksacher-smolvlm-") as directory:
                    source = Path(directory) / "video.mp4"
                    source.write_bytes(video)
                    result = describe(str(source), prompt or None)
                if not result.get("description"):
                    return self.reply(400, {"error": "Empty description"})
                self.reply(200, result)
            except ValueError:
                self.reply(400, {"error": "Could not decode video"})
            except Exception as error:
                print(f"SmolVLM inference failed: {type(error).__name__}", flush=True)
                self.reply(500, {"error": "Description failed"})

    return Handler


def main():
    """Parse flags, load local weights once, then serve or run the smoke mode."""
    parser = argparse.ArgumentParser()
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8083)
    parser.add_argument("--model", required=True)
    parser.add_argument("--device", choices=["auto", "cuda", "cpu"], default="auto")
    parser.add_argument("--max-frames", type=int, default=8)
    parser.add_argument("--describe-file", help="print one description and exit")
    args = parser.parse_args()
    if not Path(args.model).is_dir():
        raise FileNotFoundError(f"Missing local SmolVLM2 model directory: {args.model}")
    bundle = load_model(args.model, args.device)
    describe = make_describe(bundle, args.max_frames)
    if args.describe_file:
        print(describe(args.describe_file, None)["description"])
        return 0
    print(f"SmolVLM2 ready on {bundle['device']}; port {args.port}", flush=True)
    HTTPServer((args.host, args.port), handler_for(describe, bundle["device"])).serve_forever()
    return 0


if __name__ == "__main__":
    sys.exit(main())
