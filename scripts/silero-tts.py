"""Load a local Silero package and emit bounded 48 kHz mono signed 16-bit PCM.

The bot owns process cancellation and deadlines. Text travels as one argv value,
never shell code. Each invocation runs on CPU without downloading model code.
"""
import argparse
import array
import contextlib
import re
import sys


def main():
    """Synthesize plain text in sentence-sized chunks; reserve stdout for PCM."""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--model", required=True)
    parser.add_argument("--speaker", required=True)
    parser.add_argument("text")
    args = parser.parse_args()
    if not args.text.strip() or len(args.text) > 2000:
        parser.error("Text must contain 1–2000 characters")
    output = sys.stdout.buffer
    with contextlib.redirect_stdout(sys.stderr):
        import torch

        torch.set_num_threads(4)
        model = torch.package.PackageImporter(args.model).load_pickle("tts_models", "model")
        model.to(torch.device("cpu"))
        if args.speaker not in model.speakers:
            raise ValueError(f"Unknown speaker {args.speaker}; available: {model.speakers}")
        # Break long replies at punctuation or whitespace to fit the model's input limit.
        parts = re.findall(r".{1,350}(?:[.!?;]\s+|\s+|$)|\S{1,350}", " ".join(args.text.split()))
        frames = 0
        with torch.inference_mode():
            for part in parts:
                audio = model.apply_tts(text=part.strip(), speaker=args.speaker, sample_rate=48000)
                frames += audio.numel()
                if frames > 48000 * 120:
                    raise ValueError("Speech exceeds two minutes")
                samples = array.array("h", (audio.clamp(-1, 1) * 32767).to(torch.int16).tolist())
                if sys.byteorder != "little":
                    samples.byteswap()
                output.write(samples.tobytes())
                output.flush()


if __name__ == "__main__":
    main()
