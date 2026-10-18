/** @file Application composition and adapter lifecycle entry point. */
import "dotenv/config";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Ollama } from "ollama";
import { loadConfig } from "./src/config.js";
import { createMemoryStore } from "./src/core/memory.js";
import { createGifSearch } from "./src/core/gif-search.js";
import { createToolService } from "./src/core/tools.js";
import { createSupervisor } from "./src/core/supervisor.js";
import { createAssistant } from "./src/core/assistant.js";
import { createTelegramBot } from "./src/adapters/telegram.js";
import { createDiscordBot } from "./src/adapters/discord.js";

const config = loadConfig();
const memoryDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), process.env.MEMORY_DIR || "memory");
const memory = createMemoryStore(memoryDirectory);
const searchClient = config.OLLAMA_API_KEY ? new Ollama({
  host: "https://ollama.com",
  headers: { Authorization: `Bearer ${config.OLLAMA_API_KEY}` },
}) : null;
const toolService = createToolService({ searchClient, memory, gifSearch: createGifSearch({ apiKey: config.gifApiKey }) });
const modelClient = new Ollama({ host: config.OLLAMA_URL });
const supervisor = createSupervisor({ modelClient, model: config.supervisorModel, timeoutMs: config.supervisorTimeoutMs });
const assistant = createAssistant({
  modelClient, supervisor, autoMemory: config.autoMemory, spontaneous: config.spontaneous,
  autoMemoryCooldownMs: config.autoMemoryCooldownMs,
  autoMemoryCheckIntervalMs: config.autoMemoryCheckIntervalMs,
  memory, toolService,
  facts: config.facts,
  personality: config.personality,
  model: config.OLLAMA_MODEL,
  numCtx: config.OLLAMA_NUM_CTX,
  timeoutMs: config.OLLAMA_TIMEOUT,
  updateIntervalMs: 1200, // Discord message edit interval.
});
const bots = config.adapters.map((adapter) => adapter === "telegram"
  ? createTelegramBot({ config, assistant })
  : createDiscordBot({ config, assistant, memoryDirectory }));
for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => { assistant.stopObserving(); bots.forEach((bot) => bot.stop()); });
Promise.all(bots.map((bot) => bot.start())).catch((error) => {
  assistant.stopObserving();
  bots.forEach((bot) => bot.stop());
  console.error("Failed to login:", error);
  process.exitCode = 1;
});
