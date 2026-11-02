"""Resident GigaAM-v3 Russian ASR with a bounded Whisper-compatible loopback API."""
import argparse
import json
import re
import subprocess
import tempfile
import wave
from email.parser import BytesParser
from email.policy import default
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

import gigaam
import torch

SAMPLE_RATE = 16000
MAX_UPLOAD = 20 * 1024 * 1024


def audio_segments(audio):
    """Cover all samples once, cutting long audio at low-energy 100 ms boundaries.

    Chunks stay below GigaAM's 25 second limit; no speech-dependent VAD can
    discard sung or quiet passages. Each boundary is between 15 and 23 seconds.
    """
    start = 0
    while audio.numel() - start > 24 * SAMPLE_RATE:
        first = start + 15 * SAMPLE_RATE
        last = start + 23 * SAMPLE_RATE
        window = SAMPLE_RATE // 10
        frames = audio[first:last].unfold(0, window, window)
        quietest = int(frames.square().mean(dim=1).argmin())
        end = first + quietest * window + window // 2
        yield audio[start:end]
        start = end
    if start < audio.numel():
        yield audio[start:]


def transcribe(model, filename):
    """Decode the complete recording once, then recognize every bounded chunk."""
    audio = gigaam.load_audio(filename)
    if not audio.numel():
        return ""
    lines = []
    with torch.inference_mode():
        for segment in audio_segments(audio):
            # Preserve a minimum STFT input length even for a tiny final tail.
            if segment.numel() < 400:
                segment = torch.nn.functional.pad(segment, (0, 400 - segment.numel()))
            wav = segment.to(model._device).to(model._dtype).unsqueeze(0)
            length = torch.tensor([wav.shape[-1]], device=model._device)
            encoded, encoded_len = model.forward(wav, length)
            text = model._decode(encoded, encoded_len, length)[0][0].strip()
            if text:
                lines.extend(re.split(r"(?<=[.!?…])\s+", text))
    return "\n".join(lines)


def handler_for(model, device):
    """Build a handler bound to one loaded model; HTTPServer serializes inference."""
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
            self.reply(200, {"status": "ok", "backend": "gigaam", "device": device})

        def do_POST(self):
            if self.path != "/inference":
                return self.reply(404, {"error": "Not found"})
            try:
                size = int(self.headers.get("Content-Length", "0"))
                if not 0 < size <= MAX_UPLOAD + 65536:
                    self.close_connection = True
                    return self.reply(413, {"error": "Invalid upload size"})
                content_type = self.headers.get("Content-Type", "")
                if not content_type.startswith("multipart/form-data;"):
                    return self.reply(400, {"error": "Expected multipart audio"})
                body = self.rfile.read(size)
                if len(body) != size:
                    return self.reply(400, {"error": "Incomplete upload"})
                message = BytesParser(policy=default).parsebytes(
                    f"Content-Type: {content_type}\r\nMIME-Version: 1.0\r\n\r\n".encode() + body
                )
                parts = [p for p in message.iter_parts()
                         if p.get_param("name", header="content-disposition") == "file"]
                audio = parts[0].get_payload(decode=True) if len(parts) == 1 else None
                if not audio or len(audio) > MAX_UPLOAD:
                    return self.reply(400, {"error": "Invalid audio"})
                with tempfile.TemporaryDirectory(prefix="relaksacher-gigaam-") as directory:
                    source = Path(directory) / "voice.ogg"
                    source.write_bytes(audio)
                    # Bound decoded duration and memory before calling the model loader.
                    wav = Path(directory) / "voice.wav"
                    subprocess.run([
                        "ffmpeg", "-nostdin", "-v", "error", "-i", str(source),
                        "-t", "1801", "-ac", "1", "-ar", "16000", str(wav),
                    ], check=True, capture_output=True, timeout=60)
                    with wave.open(str(wav)) as decoded:
                        if decoded.getnframes() > 1800 * SAMPLE_RATE:
                            return self.reply(413, {"error": "Audio exceeds 30 minutes"})
                    text = transcribe(model, str(wav))
                self.reply(200, {"text": text})
            except (ValueError, subprocess.SubprocessError):
                self.reply(400, {"error": "Could not decode audio"})
            except Exception as error:
                print(f"GigaAM inference failed: {type(error).__name__}", flush=True)
                self.reply(500, {"error": "Transcription failed"})

    return Handler


def main():
    """Load pinned local weights once, select CUDA when available, then serve."""
    parser = argparse.ArgumentParser()
    parser.add_argument("--models", required=True)
    parser.add_argument("--device", choices=["auto", "cuda", "cpu"], default="auto")
    parser.add_argument("--port", type=int, default=8082)
    args = parser.parse_args()
    device = args.device
    if device == "auto":
        device = "cuda" if torch.cuda.is_available() else "cpu"
    torch.set_num_threads(2)
    for name in ["v3_e2e_rnnt.ckpt", "v3_e2e_rnnt_tokenizer.model"]:
        if not (Path(args.models) / name).is_file():
            raise FileNotFoundError(f"Missing local GigaAM asset: {name}")
    model = gigaam.load_model("v3_e2e_rnnt", device=device, download_root=args.models)
    print(f"GigaAM-v3 e2e_rnnt ready on {device}; port {args.port}", flush=True)
    HTTPServer(("127.0.0.1", args.port), handler_for(model, device)).serve_forever()


if __name__ == "__main__":
    main()
