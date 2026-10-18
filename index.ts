/** @file Application composition and adapter lifecycle entry point. */
import { resolvePath } from "./src/core/paths.ts";
import { Ollama } from "ollama";
import { loadConfig } from "./src/config.ts";
import { createMemoryStore } from "./src/core/memory.ts";
import { createGifSearch } from "./src/core/gif-search.ts";
import { createToolService } from "./src/core/tools.ts";
import { createSupervisor } from "./src/core/supervisor.ts";
import { createAssistant } from "./src/core/assistant.ts";
import { createTelegramBot } from "./src/adapters/telegram.ts";
import { createDiscordBot } from "./src/adapters/discord.ts";
import { createCliControls } from "./src/adapters/cli.ts";

const config = await loadConfig();
const memoryDirectory = resolvePath(Bun.env.MEMORY_DIR || "memory", import.meta.dir);
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
const cli = process.stdin.isTTY ? createCliControls({ assistant }) : null;
for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => { cli?.close(); assistant.stopObserving(); bots.forEach((bot) => bot.stop()); });
Promise.all(bots.map((bot) => bot.start())).catch((error) => {
  cli?.close();
  assistant.stopObserving();
  bots.forEach((bot) => bot.stop());
  console.error("Failed to login:", error);
  process.exitCode = 1;
});
