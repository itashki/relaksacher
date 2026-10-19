/** @file Regression coverage for models behavior and its external boundaries. */
import { temporaryDirectory } from "./temp.ts";
import { resolvePath } from "../src/core/paths.ts";
import { expect, test } from "bun:test";
import { loadConfig } from "../src/config.ts";

const env = {
  BOT_TOKEN: "test",
  OLLAMA_URL: "http://localhost:11434",
  OLLAMA_TIMEOUT: "1000",
  OLLAMA_MODEL: "test-model",
};

test("loads one main model and context from environment", async () => {
  const config = await loadConfig({ ...env, OLLAMA_MODEL: "fixed-model", OLLAMA_NUM_CTX: "32768" });
  expect(config.OLLAMA_MODEL).toBe("fixed-model");
  expect(config.OLLAMA_NUM_CTX).toBe(32768);
  expect((await loadConfig(env)).OLLAMA_NUM_CTX).toBe(16384);
  for (const model of [undefined, "", "   "]) {
    await expect(loadConfig({ ...env, OLLAMA_MODEL: model })).rejects.toThrow(/OLLAMA_MODEL/);
  }
  for (const ctx of ["0", "-1", "1.5", "invalid", ""]) {
    await expect(loadConfig({ ...env, OLLAMA_NUM_CTX: ctx })).rejects.toThrow(/OLLAMA_NUM_CTX/);
  }
});

test("Telegram-only configuration does not require Discord credentials", async () => {
  const { BOT_TOKEN: _token, ...telegramEnv } = env;
  const config = await loadConfig({
    ...telegramEnv,
    BOT_ADAPTERS: "telegram",
    TELEGRAM_BOT_TOKEN: "test-token",
  });
  expect(config.adapters).toStrictEqual(["telegram"]);
  expect(config.telegramToken).toBe("test-token");
  await expect(loadConfig({ ...telegramEnv, BOT_ADAPTERS: "telegram" })).rejects.toThrow(
    /TELEGRAM_BOT_TOKEN/,
  );
});

test("loads owner facts from JSON5 and rejects invalid facts", async () => {
  const directory = await temporaryDirectory("relaksacher-facts-");
  const file = resolvePath("facts.json5", directory);
  await Bun.write(file, "[ // owner facts\n '  Game night is Friday.  ', ]");
  expect((await loadConfig({ ...env, FACTS_FILE: file })).facts).toStrictEqual([
    "Game night is Friday.",
  ]);
  for (const value of ["{}", "[42]", "[' ']"]) {
    await Bun.write(file, value);
    await expect(loadConfig({ ...env, FACTS_FILE: file })).rejects.toThrow(/Facts file/);
  }
  await expect(
    loadConfig({ ...env, FACTS_FILE: resolvePath("missing.json5", directory) }),
  ).rejects.toThrow(/Cannot read facts/);
});

test("JSON5 personality supports commented rules and validates active entries", async () => {
  const directory = await temporaryDirectory("relaksacher-personality-");
  const file = resolvePath("personality.json5", directory);
  await Bun.write(
    file,
    "['First rule', // 'Disabled rule',\n /* another comment */ 'Second rule',]",
  );
  expect((await loadConfig({ ...env, PERSONALITY_FILE: file })).personality).toBe(
    "First rule\nSecond rule",
  );
  await Bun.write(file, "[]");
  expect((await loadConfig({ ...env, PERSONALITY_FILE: file })).personality).toBe("");
  for (const value of ["{}", "[42]", "[' ']"]) {
    await Bun.write(file, value);
    await expect(loadConfig({ ...env, PERSONALITY_FILE: file })).rejects.toThrow(
      /Personality must be/,
    );
  }
});

test("TTS defaults to bilingual Silero and accepts model and speaker overrides", async () => {
  const defaults = (await loadConfig(env)).silero;
  expect(defaults.speaker).toBe("random");
  expect(defaults.englishSpeaker).toBe("random");
  expect(
    (
      await loadConfig({
        ...env,
        SILERO_PYTHON: "/python",
        SILERO_MODEL: "/ru.pt",
        SILERO_MODEL_EN: "/en.pt",
        SILERO_SPEAKER: "aidar",
        SILERO_SPEAKER_EN: "en_10",
      })
    ).silero,
  ).toEqual({
    python: "/python",
    model: "/ru.pt",
    englishModel: "/en.pt",
    speaker: "aidar",
    englishSpeaker: "en_10",
  });
});

test("Discord configuration requires only its bot token as platform credentials", async () => {
  const config = await loadConfig({ ...env, BOT_ADAPTERS: "discord" });
  expect(config.adapters).toEqual(["discord"]);
  expect(config.token).toBe("test");
  await expect(
    loadConfig({ ...env, BOT_ADAPTERS: "discord", BOT_TOKEN: undefined }),
  ).rejects.toThrow("BOT_TOKEN");
});
