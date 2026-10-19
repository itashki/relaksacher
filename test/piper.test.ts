/** @file Regress empty-WAV failures by requiring raw synthesis with the model's native PCM rate. */
import { expect, test } from "bun:test";
import { chmod } from "node:fs/promises";
import { temporaryDirectory } from "./temp.ts";
import { createVoiceSynthesizer, piperSampleRate } from "../src/adapters/piper.ts";

test("native sample rate comes from the model sidecar and invalid metadata rejects", async () => {
  const directory = await temporaryDirectory("piper-rate-");
  const model = `${directory}/voice.onnx`;
  await Bun.write(`${model}.json`, JSON.stringify({ audio: { sample_rate: 22050 } }));
  expect(await piperSampleRate(model)).toBe(22050);
  for (const rate of [0, "22050", 22050.5, 999999]) {
    await Bun.write(`${model}.json`, JSON.stringify({ audio: { sample_rate: rate } }));
    await expect(piperSampleRate(model)).rejects.toThrow("частоту");
  }
  await expect(piperSampleRate(`${directory}/missing.onnx`)).rejects.toThrow("частоту");
});

test("short utterances use raw Piper output and preserve native-rate duration through real FFmpeg", async () => {
  const directory = await temporaryDirectory("piper-raw-");
  const model = `${directory}/voice.onnx`;
  const binary = `${directory}/fake-piper`;
  await Bun.write(`${model}.json`, JSON.stringify({ audio: { sample_rate: 16000 } }));
  // This fake reproduces Piper's empty stdout on the WAV path, but emits 0.1 seconds of raw PCM.
  await Bun.write(
    binary,
    `#!${process.execPath}\nif (Bun.argv.includes("--output-raw")) { const pcm = new Int16Array(1600).fill(1000); await Bun.write(Bun.stdout, pcm); }\n`,
  );
  await chmod(binary, 0o755);
  const service = createVoiceSynthesizer({ binary, model });
  try {
    for (const text of ["Привет", "Зеленскому осталось жить полтора часа"]) {
      const voice = await service.generate(text);
      expect(voice.duration).toBeCloseTo(0.1, 2);
      expect(await voice.audio.slice(0, 4).text()).toBe("OggS");
      expect(voice.audio.size).toBeGreaterThan(100);
    }
  } finally {
    await service.stop();
  }
});
