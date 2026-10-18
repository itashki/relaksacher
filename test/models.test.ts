import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../src/config.ts";

const env = { BOT_TOKEN: "test", APPLICANT_ID: "test", PUBLIC_KEY: "test",
  OLLAMA_URL: "http://localhost:11434", OLLAMA_TIMEOUT: "1000", OLLAMA_MODEL: "test-model" };

test("loads one main model and context from environment", () => {
  const config = loadConfig({ ...env, OLLAMA_MODEL: "fixed-model", OLLAMA_NUM_CTX: "32768" });
  assert.equal(config.OLLAMA_MODEL, "fixed-model");
  assert.equal(config.OLLAMA_NUM_CTX, 32768);
  assert.equal(loadConfig(env).OLLAMA_NUM_CTX, 16384);
  for (const model of [undefined, "", "   "]) {
    assert.throws(() => loadConfig({ ...env, OLLAMA_MODEL: model }), /OLLAMA_MODEL/);
  }
  for (const ctx of ["0", "-1", "1.5", "invalid", ""]) {
    assert.throws(() => loadConfig({ ...env, OLLAMA_NUM_CTX: ctx }), /OLLAMA_NUM_CTX/);
  }
});

test("Telegram-only configuration does not require Discord credentials", () => {
  const { BOT_TOKEN, APPLICANT_ID, PUBLIC_KEY, ...telegramEnv } = env;
  const config = loadConfig({ ...telegramEnv, BOT_ADAPTERS: "telegram", TELEGRAM_BOT_TOKEN: "test-token" });
  assert.deepEqual(config.adapters, ["telegram"]);
  assert.equal(config.telegramToken, "test-token");
  assert.throws(() => loadConfig({ ...telegramEnv, BOT_ADAPTERS: "telegram" }), /TELEGRAM_BOT_TOKEN/);
});

test("loads owner facts from JSON5 and rejects invalid facts", (t) => {
  const directory = mkdtempSync(path.join(tmpdir(), "relaksacher-facts-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, "facts.json5");
  writeFileSync(file, "[ // owner facts\n '  Game night is Friday.  ', ]");
  assert.deepEqual(loadConfig({ ...env, FACTS_FILE: file }).facts, ["Game night is Friday."]);
  for (const value of ["{}", "[42]", "[' ']"]) {
    writeFileSync(file, value);
    assert.throws(() => loadConfig({ ...env, FACTS_FILE: file }), /Facts file/);
  }
  assert.throws(() => loadConfig({ ...env, FACTS_FILE: path.join(directory, "missing.json5") }), /Cannot read facts/);
});

test("JSON5 personality supports commented rules and validates active entries", (t) => {
  const directory = mkdtempSync(path.join(tmpdir(), "relaksacher-personality-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, "personality.json5");
  writeFileSync(file, "['First rule', // 'Disabled rule',\n /* another comment */ 'Second rule',]");
  assert.equal(loadConfig({ ...env, PERSONALITY_FILE: file }).personality, "First rule\nSecond rule");
  writeFileSync(file, "[]");
  assert.equal(loadConfig({ ...env, PERSONALITY_FILE: file }).personality, "");
  for (const value of ["{}", "[42]", "[' ']"]) {
    writeFileSync(file, value);
    assert.throws(() => loadConfig({ ...env, PERSONALITY_FILE: file }), /Personality must be/);
  }
});
