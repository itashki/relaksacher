/** @file Synthesize Piper speech as a live PCM stream or a bounded OGG/Opus voice recording. */
import { createMusicPipeline } from "./music-process.ts";
import PQueue from "p-queue";
/** Read the model's native PCM rate; raw Piper output has no header to infer this from.
 * Rejects missing/invalid sidecar configuration before any subprocess is started. */
export async function piperSampleRate(model: string): Promise<number> {
  try {
    const config = await Bun.file(`${model}.json`).json();
    const rate = config.audio?.sample_rate;
    if (!Number.isSafeInteger(rate) || rate < 8000 || rate > 192000)
      throw new Error("Invalid sample rate");
    return rate;
  } catch {
    throw new Error(
      "Не удалось прочитать частоту голоса. Проверьте файл PIPER_MODEL.onnx.json рядом с моделью.",
    );
  }
}

/** Stream Piper's raw 16-bit mono PCM, resampled to Discord PCM. Avoids Piper's buffered WAV stdout path. */
export function createPiperPipeline(
  binary: string,
  model: string,
  text: string,
  onFailure: () => void,
  sampleRate: number,
) {
  return createMusicPipeline(
    [binary, "-m", model, "--output-raw", "--", text.replace(/\s+/gu, " ")],
    [
      "ffmpeg",
      "-nostdin",
      "-loglevel",
      "error",
      "-f",
      "s16le",
      "-ar",
      String(sampleRate),
      "-ac",
      "1",
      "-i",
      "pipe:0",
      "-f",
      "s16le",
      "-ar",
      "48000",
      "-ac",
      "2",
      "pipe:1",
    ],
    onFailure,
  );
}

/** Calculate actual length and a waveform from 48 kHz signed 16-bit stereo PCM. */
export function voiceMetadata(pcm: ArrayBuffer) {
  const samples = new DataView(pcm);
  const frames = Math.floor(pcm.byteLength / 4);
  const count = Math.min(256, Math.ceil(frames / 4800));
  const waveform = new Uint8Array(count);
  for (let index = 0; index < count; index++) {
    const begin = Math.floor((index * frames) / count);
    const end = Math.floor(((index + 1) * frames) / count);
    let peak = 0;
    for (let frame = begin; frame < end; frame++)
      peak = Math.max(
        peak,
        Math.abs(samples.getInt16(frame * 4, true)),
        Math.abs(samples.getInt16(frame * 4 + 2, true)),
      );
    waveform[index] = Math.min(255, Math.round((peak * 255) / 32768));
  }
  return { duration: frames / 48000, waveform: waveform.toBase64() };
}

/** Share one bounded synthesis worker between adapters; stop() cancels all pending work.
 * Recordings contain at most two minutes of mono OGG/Opus and are never stored on disk by the bot. */
export function createVoiceSynthesizer({
  binary = "piper",
  model = "models/ru_RU-ruslan-medium.onnx",
}: { binary?: string; model?: string } = {}) {
  const queue = new PQueue({ concurrency: 1 });
  const shutdown = new AbortController();
  return {
    async generate(text: string): Promise<import("../types.ts").VoiceRecording> {
      if (!text.trim() || text.length > 2000)
        throw new Error("Для озвучки нужен текст длиной от 1 до 2000 символов.");
      shutdown.signal.throwIfAborted();
      if (queue.size >= 20) throw new Error("Очередь голосовых сообщений заполнена.");
      return queue.add(async () => {
        shutdown.signal.throwIfAborted();
        const deadline = AbortSignal.any([shutdown.signal, AbortSignal.timeout(120000)]);
        const sampleRate = await piperSampleRate(model);
        deadline.throwIfAborted();
        let failed = false;
        const pipeline = createPiperPipeline(
          binary,
          model,
          text,
          () => {
            failed = true;
          },
          sampleRate,
        );
        const abort = () => pipeline.stop();
        deadline.addEventListener("abort", abort, { once: true });
        let pcm: ArrayBuffer;
        try {
          const chunks: Uint8Array[] = [];
          let size = 0;
          for await (const chunk of pipeline.stream) {
            size += chunk.length;
            if (size > 48000 * 4 * 120) throw new Error("Голосовое превышает две минуты.");
            chunks.push(new Uint8Array(chunk));
          }
          const codes = await pipeline.exited;
          deadline.throwIfAborted();
          if (failed || codes.some((code) => code !== 0))
            throw new Error("Piper не смог синтезировать речь. Проверьте PIPER_BIN и модель.");
          if (!size) throw new Error("Piper вернул пустое аудио. Попробуйте текст со словами.");
          pcm = Bun.concatArrayBuffers(chunks);
        } finally {
          deadline.removeEventListener("abort", abort);
          pipeline.stop();
          await pipeline.exited;
        }
        deadline.throwIfAborted();
        const encoder = Bun.spawn(
          [
            "ffmpeg",
            "-nostdin",
            "-loglevel",
            "error",
            "-f",
            "s16le",
            "-ar",
            "48000",
            "-ac",
            "2",
            "-i",
            "pipe:0",
            "-ac",
            "1",
            "-c:a",
            "libopus",
            "-b:a",
            "32k",
            "-f",
            "ogg",
            "pipe:1",
          ],
          {
            stdin: new Blob([pcm]),
            stdout: "pipe",
            stderr: "ignore",
            signal: deadline,
            killSignal: "SIGKILL",
          },
        );
        try {
          const chunks: Uint8Array[] = [];
          let size = 0;
          for await (const chunk of encoder.stdout) {
            size += chunk.length;
            if (size > 4 * 1024 * 1024) throw new Error("Голосовой файл слишком большой.");
            chunks.push(chunk);
          }
          if ((await encoder.exited) !== 0 || !size)
            throw new Error("Не удалось создать OGG/Opus. Проверьте FFmpeg.");
          deadline.throwIfAborted();
          return {
            audio: new Blob([Bun.concatArrayBuffers(chunks)], { type: "audio/ogg" }),
            ...voiceMetadata(pcm),
          };
        } finally {
          encoder.kill("SIGKILL");
          await encoder.exited;
        }
      });
    },
    /** Cancel synthesis and wait for process cleanup; subsequent requests reject. */
    async stop() {
      shutdown.abort();
      await queue.onIdle();
    },
  };
}
