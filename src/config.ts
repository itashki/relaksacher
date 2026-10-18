const projectDirectory = Bun.fileURLToPath(new URL("../", import.meta.url));

async function readConfigFile(filename: string) {
  const file = Bun.resolveSync(filename.startsWith("/") ? filename : `./${filename}`, projectDirectory);
  return Bun.JSON5.parse(await Bun.file(file).text());
}

/**
 * Read and validate owner-provided facts relative to the project directory.
 * @param filename JSON5 fact-list path.
 * @returns Trimmed facts.
 * @throws {Error} When the file is missing, malformed, or contains invalid entries.
 */
async function loadFacts(filename: string = "facts.json5") {
  let facts;
  try {
    facts = await readConfigFile(filename);
  } catch (error) {
    throw new Error(`Cannot read facts from ${filename}: ${error.message}`, { cause: error });
  }
  if (!Array.isArray(facts) || facts.some((fact) => typeof fact !== "string" || !fact.trim())) {
    throw new Error("Facts file must contain an array of non-empty strings");
  }
  return facts.map((fact) => fact.trim());
}

/**
 * Load credentials, local prompts and adapter/model settings at startup.
 * @param env Environment to read without mutation.
 * @returns Validated application configuration.
 * @throws {Error} When required credentials or configuration values are invalid.
 */
export async function loadConfig(env: Record<string, string | undefined> = Bun.env) {
  const facts = await loadFacts(env.FACTS_FILE);
  const personalityFile = env.PERSONALITY_FILE || "personality.json5";
  let personality;
  try {
    const rules = await readConfigFile(personalityFile);
    if (!Array.isArray(rules) || rules.some((rule) => typeof rule !== "string" || !rule.trim())) {
      throw new Error("Personality must be an array of non-empty strings");
    }
    personality = rules.map((rule) => rule.trim()).join("\n");
  } catch (error) {
    throw new Error(`Cannot read personality from ${personalityFile}: ${error.message}`, { cause: error });
  }
  const supervisorModel = env.OLLAMA_SUPERVISOR_MODEL || "qwen3:0.6b";
  const supervisorTimeoutMs = Number(env.OLLAMA_SUPERVISOR_TIMEOUT_MS ?? 30000);
  if (!Number.isSafeInteger(supervisorTimeoutMs) || supervisorTimeoutMs <= 0) throw new Error("Invalid OLLAMA_SUPERVISOR_TIMEOUT_MS");
  const autoMemory = env.AUTO_MEMORY !== "false";
  const autoMemoryCooldownMs = Number(env.AUTO_MEMORY_COOLDOWN_MS ?? 120000);
  const autoMemoryCheckIntervalMs = Number(env.AUTO_MEMORY_CHECK_INTERVAL_MS ?? 60000);
  if (![autoMemoryCooldownMs, autoMemoryCheckIntervalMs].every((value) => Number.isSafeInteger(value) && value >= 1000)) {
    throw new Error("Automatic memory intervals must be integers of at least 1000 ms");
  }
  const spontaneous = {
    enabled: env.SPONTANEOUS_REPLIES !== "false",
    chance: Number(env.SPONTANEOUS_CHANCE ?? 0.05),
    cooldownMs: Number(env.SPONTANEOUS_COOLDOWN_MS ?? 300000),
  };
  if (!Number.isFinite(spontaneous.chance) || spontaneous.chance < 0 || spontaneous.chance > 1 ||
      !Number.isSafeInteger(spontaneous.cooldownMs) || spontaneous.cooldownMs < 30000) {
    throw new Error("Invalid spontaneous reply probability or cooldown (minimum 30000 ms)");
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
  const OLLAMA_MODEL = env.OLLAMA_MODEL?.trim();
  if (!OLLAMA_MODEL) throw new Error("OLLAMA_MODEL is required; set it in .env.");
  const OLLAMA_TIMEOUT = parseInt(env.OLLAMA_TIMEOUT, 10);
  // Необязателен: без ключа используется резервный веб-поиск.
  const OLLAMA_API_KEY = env.OLLAMA_API_KEY || null;
  // Размер контекстного окна. По умолчанию Ollama часто даёт всего 2-4k токенов,
  // и результаты поиска просто обрезаются.
  const OLLAMA_NUM_CTX = Number(env.OLLAMA_NUM_CTX ?? 16384);
  if (!Number.isSafeInteger(OLLAMA_NUM_CTX) || OLLAMA_NUM_CTX <= 0) {
    throw new Error("OLLAMA_NUM_CTX must be a positive integer.");
  }
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
    gifApiKey: env.KLIPY_API_KEY?.trim() || null,
    supervisorModel,
    supervisorTimeoutMs,
    autoMemory,
    autoMemoryCooldownMs,
    autoMemoryCheckIntervalMs,
    spontaneous,
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
    OLLAMA_TIMEOUT,
    OLLAMA_API_KEY,
    OLLAMA_NUM_CTX,
  };
}
