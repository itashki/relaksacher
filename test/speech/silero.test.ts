/** @file Verify Silero language routing and bounded recording conversion through real FFmpeg. */
import { expect, test, spyOn } from "bun:test";
import { chmod } from "node:fs/promises";
import { temporaryDirectory } from "../support/temp.ts";
import {
  createVoiceSynthesizer,
  speechSource,
  parseSpeechArguments,
} from "../../src/adapters/speech/silero.ts";

test("Silero routes the original language before expanding speech text without a shell", async () => {
  const silero = {
    python: "/runtime/python3",
    model: "/voices/ru.pt",
    englishModel: "/voices/en.pt",
    speaker: "xenia",
    englishSpeaker: "en_0",
  };
  for (const [text, model, speaker, spoken] of [
    ["Привет $HOME `echo`", silero.model, silero.speaker, "Привет долларов HOME `echo`"],
    [
      "Hello $(echo hello)",
      silero.englishModel,
      silero.englishSpeaker,
      "Hello dollars (echo hello)",
    ],
    ["Hello мир", silero.model, silero.speaker, "Hello мир"],
    ["123", silero.model, silero.speaker, "сто двадцать три"],
    ["Ёж", silero.model, silero.speaker, "Ёж"],
    ["@", silero.model, silero.speaker, "собака"],
    ["Hello @user 50%", silero.englishModel, silero.englishSpeaker, "Hello at user fifty percent"],
  ]) {
    const source = await speechSource(text, { silero });
    expect(source.sampleRate).toBe(48000);
    expect(source.command[0]).toBe(silero.python);
    expect(source.command.slice(2)).toEqual(["--model", model, "--speaker", speaker, "--", spoken]);
  }
});

test("Silero rejects text without pronounceable content before starting a process", () => {
  for (const text of ["", "...?!", "😀", "   "])
    expect(() => speechSource(text, {})).toThrow("нет произносимых");
  expect(speechSource("^^^^^^ъьъьъьъьъьъьъьъъь", {}).command.at(-1)).toBe(
    "крышка крышка крышка крышка крышка крышка твёрдый знак мягкий знак твёрдый знак мягкий знак твёрдый знак мягкий знак твёрдый знак мягкий знак твёрдый знак мягкий знак твёрдый знак мягкий знак твёрдый знак мягкий знак твёрдый знак твёрдый знак мягкий знак",
  );
});

test("short Silero recordings preserve duration and encode OGG/Opus", async () => {
  const directory = await temporaryDirectory("silero-raw-");
  const python = `${directory}/fake-python`;
  await Bun.write(
    python,
    `#!${process.execPath}\nawait Bun.write(Bun.stdout, new Int16Array(4800).fill(1000));\n`,
  );
  await chmod(python, 0o755);
  const service = createVoiceSynthesizer({
    silero: {
      python,
      model: "ru.pt",
      englishModel: "en.pt",
      speaker: "xenia",
      englishSpeaker: "en_0",
    },
  });
  try {
    for (const text of ["Привет", "Hello"]) {
      const voice = await service.generate(text);
      expect(voice.duration).toBeCloseTo(0.1, 2);
      expect(await voice.audio.slice(0, 4).text()).toBe("OggS");
      expect(voice.audio.size).toBeGreaterThan(100);
    }
  } finally {
    await service.stop();
  }
});

test("random voices use actual speakers of each language and explicit choices override defaults", () => {
  const random = spyOn(Math, "random");
  try {
    for (const [draw, ru, en] of [
      [0, "aidar", "en_0"],
      [0.9999, "xenia", "en_117"],
    ] as const) {
      random.mockReturnValue(draw);
      expect(speechSource("Привет", {}).command[5]).toBe(ru);
      expect(speechSource("Hello", {}).command[5]).toBe(en);
    }
    expect(speechSource("Привет", {}, "eugene").command[5]).toBe("eugene");
    expect(speechSource("Hello", {}, "en_42").command[5]).toBe("en_42");
    expect(() => speechSource("Hello", {}, "xenia")).toThrow("английского");
    expect(() => speechSource("Привет", {}, "en_0")).toThrow("русского");
  } finally {
    random.mockRestore();
  }
});

test("speech arguments support speaker-only replies, literal text and invalid options", () => {
  expect(parseSpeechArguments("--speaker xenia Привет")).toEqual({
    speaker: "xenia",
    text: "Привет",
  });
  expect(parseSpeechArguments("--speaker=en_42 Hello")).toEqual({
    speaker: "en_42",
    text: "Hello",
  });
  expect(parseSpeechArguments("--speaker random")).toEqual({ speaker: "random", text: "" });
  expect(parseSpeechArguments("-- --speaker text")).toEqual({
    speaker: undefined,
    text: "--speaker text",
  });
  for (const input of ["--speaker", "--speaker unknown", "--speaker en_118 Hello"])
    expect(() => parseSpeechArguments(input)).toThrow();
});
