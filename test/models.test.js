/** @file Regression tests for models.test. */
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { createModelSelector } from "../src/core/models.js";
import { loadConfig } from "../src/config.js";

const env = { BOT_TOKEN: "test", APPLICANT_ID: "test", PUBLIC_KEY: "test",
  OLLAMA_URL: "http://localhost:11434", OLLAMA_TIMEOUT: "1000" };

test("model pool supports selection of every model with its alias", () => {
  const models = [{ name: "one", alias: "терн", numCtx: 131072 }, { name: "two", alias: "шип" }];
  const config = loadConfig({ ...env, OLLAMA_MODELS: JSON.stringify(models) });
  let index = 0;
  const select = createModelSelector(config.OLLAMA_MODELS, (length) => {
    assert.equal(length, 2);
    return index++;
  });
  assert.deepEqual(select(), models[0]);
  assert.deepEqual(select(), models[1]);
});

test("legacy single-model config works and malformed pools are rejected", () => {
  assert.deepEqual(loadConfig({ ...env, OLLAMA_MODEL: "old-model" }).OLLAMA_MODELS,
    [{ name: "old-model", alias: "р" }]);
  for (const pool of [[], [{}], [{ name: "one", alias: "@everyone" }],
    ...[0, -1, 1.5, "32768"].map((numCtx) => [{ name: "one", alias: "ok", numCtx }])]) {
    assert.throws(() => loadConfig({ ...env, OLLAMA_MODELS: JSON.stringify(pool) }), /OLLAMA_MODELS/);
  }
});

test("model file takes precedence over legacy settings and resolves from the project root", () => {
  const config = loadConfig({ ...env, OLLAMA_MODELS_FILE: "models.json5", OLLAMA_MODELS: "invalid legacy JSON" });
  assert.ok(config.OLLAMA_MODELS.length > 0);
  assert.ok(config.OLLAMA_MODELS.every((model) => model.name && model.alias));
  assert.deepEqual(loadConfig(env).OLLAMA_MODELS, config.OLLAMA_MODELS);
  assert.throws(() => loadConfig({ ...env, OLLAMA_MODELS_FILE: "missing-models.json" }), /Cannot read model list/);
});

test("loads JSON5 model files with comments, unquoted keys, single quotes and trailing commas", (t) => {
  const directory = mkdtempSync(path.join(tmpdir(), "relaksacher-json5-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, "models.json5");
  writeFileSync(file, `// Available models
  [
    /* primary */ { name: 'example:latest', alias: 'test', numCtx: 32768, },
  ]`);
  assert.deepEqual(loadConfig({ ...env, OLLAMA_MODELS_FILE: file }).OLLAMA_MODELS,
    [{ name: "example:latest", alias: "test", numCtx: 32768 }]);
  writeFileSync(file, "[ /* unclosed");
  assert.throws(() => loadConfig({ ...env, OLLAMA_MODELS_FILE: file }), /Cannot read model list/);
});

test("Telegram-only configuration does not require Discord credentials", () => {
  const { BOT_TOKEN, APPLICANT_ID, PUBLIC_KEY, ...telegramEnv } = env;
  const config = loadConfig({ ...telegramEnv, BOT_ADAPTERS: "telegram", TELEGRAM_BOT_TOKEN: "test-token" });
  assert.deepEqual(config.adapters, ["telegram"]);
  assert.equal(config.telegramToken, "test-token");
  assert.throws(() => loadConfig({ ...telegramEnv, BOT_ADAPTERS: "telegram" }), /TELEGRAM_BOT_TOKEN/);
});

test("single-model pools hide the signature without changing configuration", () => {
  const model = { name: "only-model", alias: "терн", numCtx: 131072 };
  const selected = createModelSelector([model])();
  assert.equal(selected.name, model.name);
  assert.equal(selected.numCtx, model.numCtx);
  assert.equal(selected.alias, undefined);
  assert.equal(model.alias, "терн");
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
