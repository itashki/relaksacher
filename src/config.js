import JSON5 from "json5";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectDirectory = fileURLToPath(new URL("../", import.meta.url));

function loadModelPool(env) {
  const filename = env.OLLAMA_MODELS_FILE ||
    (!env.OLLAMA_MODELS && !env.OLLAMA_MODEL ? "models.json5" : null);
  if (filename) {
    const file = path.resolve(projectDirectory, filename);
    try {
      return JSON5.parse(readFileSync(file, "utf8"));
    } catch (error) {
      throw new Error(`Cannot read model list from ${file}: ${error.message}`, { cause: error });
    }
  }
  return env.OLLAMA_MODELS
    ? JSON.parse(env.OLLAMA_MODELS)
    : [{ name: env.OLLAMA_MODEL, alias: "р" }];
}

function loadFacts(filename = "facts.json5") {
  const file = path.resolve(projectDirectory, filename);
  let facts;
  try {
    facts = JSON5.parse(readFileSync(file, "utf8"));
  } catch (error) {
    throw new Error(`Cannot read facts from ${file}: ${error.message}`, { cause: error });
  }
  if (!Array.isArray(facts) || facts.some((fact) => typeof fact !== "string" || !fact.trim())) {
    throw new Error("Facts file must contain an array of non-empty strings");
  }
  return facts.map((fact) => fact.trim());
}

export function loadConfig(env = process.env) {
  const facts = loadFacts(env.FACTS_FILE);
  const personalityFile = path.resolve(projectDirectory, env.PERSONALITY_FILE || "personality.json5");
  let personality;
  try {
    const rules = JSON5.parse(readFileSync(personalityFile, "utf8"));
    if (!Array.isArray(rules) || rules.some((rule) => typeof rule !== "string" || !rule.trim())) {
      throw new Error("Personality must be an array of non-empty strings");
    }
    personality = rules.map((rule) => rule.trim()).join("\n");
  } catch (error) {
    throw new Error(`Cannot read personality from ${personalityFile}: ${error.message}`, { cause: error });
  }
  const token = env.BOT_TOKEN;
  const telegramToken = env.TELEGRAM_BOT_TOKEN;
  const telegramUpdateIntervalMs = Number(env.TELEGRAM_UPDATE_INTERVAL_MS ?? 5000);
  if (!Number.isSafeInteger(telegramUpdateIntervalMs) || telegramUpdateIntervalMs < 1000) {
    throw new Error("TELEGRAM_UPDATE_INTERVAL_MS must be an integer of at least 1000");
  }
  const telegramTimeoutMs = Number(env.TELEGRAM_TIMEOUT_MS ?? 60000);
  if (!Number.isSafeInteger(telegramTimeoutMs) || telegramTimeoutMs <= 0) {
    throw new Error("TELEGRAM_TIMEOUT_MS must be a positive integer");
  }
  const adapters = (env.BOT_ADAPTERS || (token ? "discord" : "telegram"))
    .split(",").map((name) => name.trim()).filter(Boolean);
  if (!adapters.length || adapters.some((name) => !["discord", "telegram"].includes(name))) {
    throw new Error("BOT_ADAPTERS must contain discord and/or telegram");
  }
  if (adapters.includes("telegram") && !telegramToken) {
    throw new Error("TELEGRAM_BOT_TOKEN is required for the Telegram adapter");
  }
  const applicantId = env.APPLICANT_ID;
  const publicKey = env.PUBLIC_KEY;
  const OLLAMA_URL = env.OLLAMA_URL;
  const OLLAMA_MODEL = env.OLLAMA_MODEL;
  const OLLAMA_MODELS = loadModelPool(env);
  if (!Array.isArray(OLLAMA_MODELS) || !OLLAMA_MODELS.length ||
      OLLAMA_MODELS.some((entry) =>
        typeof entry?.name !== "string" || !entry.name.trim() ||
        typeof entry.alias !== "string" || !/^[\p{L}\p{N}_-]{1,16}$/u.test(entry.alias) ||
        (entry.numCtx !== undefined && (!Number.isSafeInteger(entry.numCtx) || entry.numCtx <= 0)))) {
    throw new Error("Model list (OLLAMA_MODELS / OLLAMA_MODELS_FILE) must be a non-empty JSON array of { name, alias }; aliases must be 1–16 letters, digits, underscores or hyphens; optional numCtx must be a positive integer.");
  }
  const OLLAMA_TIMEOUT = parseInt(env.OLLAMA_TIMEOUT, 10);
  // Необязателен: без ключа веб-поиск просто отключён.
  const OLLAMA_API_KEY = env.OLLAMA_API_KEY || null;
  // Размер контекстного окна. По умолчанию Ollama часто даёт всего 2-4k токенов,
  // и результаты поиска просто обрезаются.
  const OLLAMA_NUM_CTX = parseInt(env.OLLAMA_NUM_CTX, 10) || 16384;
  if (adapters.includes("discord") && !token) {
    throw new Error("BOT_TOKEN is not defined in the environment variables.");
  }
  if (adapters.includes("discord") && !applicantId) {
    throw new Error(
      "APPLICANT_ID is not defined in the environment variables.",
    );
  }
  if (adapters.includes("discord") && !publicKey) {
    throw new Error("PUBLIC_KEY is not defined in the environment variables.");
  }
  if (!OLLAMA_URL) {
    throw new Error("OLLAMA_URL is not defined in the environment variables.");
  }
  if (isNaN(OLLAMA_TIMEOUT)) {
    throw new Error("OLLAMA_TIMEOUT is not a valid number.");
  }
  return {
    facts,
    personality,
    token,
    telegramToken,
    telegramTimeoutMs,
    telegramUpdateIntervalMs,
    adapters,
    applicantId,
    publicKey,
    OLLAMA_URL,
    OLLAMA_MODEL,
    OLLAMA_MODELS,
    OLLAMA_TIMEOUT,
    OLLAMA_API_KEY,
    OLLAMA_NUM_CTX,
  };
}
