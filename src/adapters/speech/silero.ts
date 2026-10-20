/** @file Synthesize Silero speech as a live PCM stream or a bounded OGG/Opus voice recording. */
import { createMusicPipeline } from "../music/process.ts";
import PQueue from "p-queue";
import { normalizeSpeechText } from "../../core/speech/text.ts";
/** Local CPU Silero runtime and independent Russian/English models and speaker IDs. */
export type SileroOptions = {
  python: string;
  model: string;
  englishModel: string;
  speaker: string;
  englishSpeaker: string;
};

/** Shared Silero settings for recordings and Discord live speech. */
export type SpeechOptions = { silero?: SileroOptions };

const russianSpeakers = ["aidar", "baya", "kseniya", "eugene", "xenia"];
const englishSpeakers = Array.from({ length: 118 }, (_, index) => `en_${index}`);

/** Parse an optional leading --speaker ID; -- ends options and preserves literal text. */
export function parseSpeechArguments(input: string = "") {
  const argument = input.trim();
  if (argument === "--" || argument.startsWith("-- "))
    return { text: argument.slice(2).trim(), speaker: undefined };
  if (!/^--speaker(?:\s|=|$)/iu.test(argument)) return { text: argument, speaker: undefined };
  const match = argument.match(/^--speaker(?:\s+|=)([a-z][a-z0-9_]*)(?:\s+([\s\S]*))?$/iu);
  if (!match) throw new Error("Укажите спикера: --speaker xenia или --speaker en_0.");
  const speaker = match[1].toLowerCase();
  if (
    speaker !== "random" &&
    !russianSpeakers.includes(speaker) &&
    !englishSpeakers.includes(speaker)
  )
    throw new Error(
      "Неизвестный спикер. Доступны aidar, baya, kseniya, eugene, xenia, en_0–en_117 и random.",
    );
  const text = (match[2] ?? "").replace(/^--(?:\s|$)/u, "").trim();
  return { text, speaker };
}

/** Choose a language-compatible speaker once per utterance; random draws uniformly from real voices. */
export function speechSource(text: string, options: SpeechOptions, requestedSpeaker?: string) {
  const silero = options.silero ?? {
    python: "python3",
    model: "models/silero-v5_6_ru.pt",
    englishModel: "models/silero-v3_en.pt",
    speaker: "random",
    englishSpeaker: "random",
  };
  const english = /[a-z]/iu.test(text) && !/[а-яё]/iu.test(text);
  const spokenText = normalizeSpeechText(text, english);
  if (!/[a-zа-яё]/iu.test(spokenText))
    throw new Error("В тексте нет произносимых слов или поддерживаемых символов для озвучки.");
  const available = english ? englishSpeakers : russianSpeakers;
  const configured = requestedSpeaker ?? (english ? silero.englishSpeaker : silero.speaker);
  const speaker =
    configured === "random" ? available[Math.floor(Math.random() * available.length)] : configured;
  if (!available.includes(speaker))
    throw new Error(
      english
        ? "Для английского текста выберите en_0–en_117 или random."
        : "Для русского текста выберите aidar, baya, kseniya, eugene, xenia или random.",
    );
  return {
    command: [
      silero.python,
      Bun.fileURLToPath(new URL("../../../scripts/silero-tts.py", import.meta.url)),
      "--model",
      english ? silero.englishModel : silero.model,
      "--speaker",
      speaker,
      "--",
      spokenText,
    ],
    sampleRate: 48000,
  };
}

/** Resample a backend's signed 16-bit mono PCM into Discord's 48 kHz stereo PCM. */
export function createSpeechPipeline(command: string[], onFailure: () => void, sampleRate: number) {
  return createMusicPipeline(
    command,
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
export function createVoiceSynthesizer(options: SpeechOptions = {}) {
  const queue = new PQueue({ concurrency: 1 });
  const shutdown = new AbortController();
  return {
    async generate(
      text: string,
      speaker?: string,
    ): Promise<import("../../types.ts").VoiceRecording> {
      if (!text.trim() || text.length > 2000)
        throw new Error("Для озвучки нужен текст длиной от 1 до 2000 символов.");
      shutdown.signal.throwIfAborted();
      if (queue.size >= 20) throw new Error("Очередь голосовых сообщений заполнена.");
      return queue.add(async () => {
        shutdown.signal.throwIfAborted();
        const deadline = AbortSignal.any([shutdown.signal, AbortSignal.timeout(120000)]);
        const source = speechSource(text, options, speaker);
        deadline.throwIfAborted();
        let failed = false;
        const pipeline = createSpeechPipeline(
          source.command,
          () => {
            failed = true;
          },
          source.sampleRate,
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
            throw new Error("Не удалось синтезировать речь. Проверьте Silero, Python и модели.");
          if (!size) throw new Error("TTS вернул пустое аудио. Попробуйте текст со словами.");
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
