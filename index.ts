/** @file Application composition and adapter lifecycle entry point. */
import { createVoiceSynthesizer } from "./src/adapters/piper.ts";
import { createWhisperServer } from "./src/core/whisper-server.ts";
import { createTranscriber } from "./src/core/transcription.ts";
import { createShutdown } from "./src/core/shutdown.ts";
import { createMusicMonitor } from "./src/core/music-status.ts";
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
const voice = createVoiceSynthesizer({
  binary: config.piperBin,
  model: config.piperModel,
  englishModel: config.piperEnglishModel,
  silero: config.silero,
});
const whisper = createWhisperServer({
  url: config.whisperUrl,
  model: config.whisperModel,
  enabled: config.whisperAutoStart,
});
const transcribe = createTranscriber({
  url: config.whisperUrl,
  timeoutMs: config.whisperTimeoutMs,
});
const memoryDirectory = resolvePath(Bun.env.MEMORY_DIR || "memory", import.meta.dir);
const memory = createMemoryStore(memoryDirectory);
const searchClient = config.OLLAMA_API_KEY
  ? new Ollama({
      host: "https://ollama.com",
      headers: { Authorization: `Bearer ${config.OLLAMA_API_KEY}` },
    })
  : null;
const toolService = createToolService({
  searchClient,
  memory,
  gifSearch: createGifSearch({ apiKey: config.gifApiKey }),
});
const modelClient = new Ollama({ host: config.OLLAMA_URL });
const supervisor = createSupervisor({
  modelClient,
  model: config.supervisorModel,
  timeoutMs: config.supervisorTimeoutMs,
});
const assistant = createAssistant({
  modelClient,
  supervisor,
  autoMemory: config.autoMemory,
  spontaneous: config.spontaneous,
  autoMemoryCooldownMs: config.autoMemoryCooldownMs,
  autoMemoryCheckIntervalMs: config.autoMemoryCheckIntervalMs,
  memory,
  toolService,
  facts: config.facts,
  personality: config.personality,
  model: config.OLLAMA_MODEL,
  numCtx: config.OLLAMA_NUM_CTX,
  timeoutMs: config.OLLAMA_TIMEOUT,
  updateIntervalMs: 1200, // Discord message edit interval.
});
const music = createMusicMonitor();
const bots = config.adapters.map((adapter) =>
  adapter === "telegram"
    ? createTelegramBot({ config, assistant, transcribe, generateVoice: voice.generate })
    : createDiscordBot({
        config,
        assistant,
        transcribe,
        generateVoice: voice.generate,
        memoryDirectory,
        onMusicStatus: music.publish,
      }),
);
const cli = process.stdin.isTTY
  ? createCliControls({ assistant, music: config.adapters.includes("discord") ? music : undefined })
  : null;
const shutdown = createShutdown({
  steps: [
    () => cli?.close(),
    () => whisper.stop(),
    () => voice.stop(),
    () => process.stdin.pause(),
    () => assistant.stopObserving(),
    () => assistant.stopCurrentGeneration(),
    () => modelClient.abort(),
    () => searchClient?.abort(),
    ...bots.map((bot) => () => bot.stop()),
  ],
});
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.on(signal, () => {
    void shutdown.run();
  });
whisper
  .start()
  .then(() => {
    if (shutdown.started) return;
    return Promise.all(bots.map((bot) => bot.start()));
  })
  .catch((error) => {
    if (shutdown.started) return;
    console.error("Failed to start application:", error);
    void shutdown.run(1);
  });
