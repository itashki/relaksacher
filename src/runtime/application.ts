/** @file Replaceable application composition; messenger transports belong to the persistent host. */
import { Ollama } from "ollama";
import { loadConfig } from "../config.ts";
import { createVoiceSynthesizer } from "../adapters/speech/silero.ts";
import { createTranscriber } from "../core/speech/transcription.ts";
import { createMemoryStore } from "../core/memory/index.ts";
import { createGifSearch } from "../core/tools/gif-search.ts";
import { createToolService } from "../core/tools/index.ts";
import { createSupervisor } from "../core/assistant/supervisor.ts";
import { createAssistant } from "../core/assistant/index.ts";
import { createTelegramBot } from "../adapters/telegram/index.ts";
import { createDiscordBot } from "../adapters/discord/index.ts";
import { resolvePath } from "../core/paths.ts";
import { projectDirectory } from "../core/project.ts";
import type { AppConfig } from "../types.ts";
import type { RuntimeEvent, RuntimeTransports } from "./contracts.ts";

export { loadConfig };
export { createCliControls } from "../adapters/terminal/cli.ts";
export { createTerminalSession } from "../adapters/terminal/session.ts";

/** Construct fresh handlers without logging in, polling, or consuming incoming events. */
export function createApplication(
  config: AppConfig,
  transports: RuntimeTransports,
  onMusicStatus: Parameters<typeof createDiscordBot>[0]["onMusicStatus"],
  onRequest?: import("../core/statistics.ts").RecordRequest,
) {
  const voice = createVoiceSynthesizer({ silero: config.silero });
  const transcribe = createTranscriber({
    url: config.whisperUrl,
    timeoutMs: config.whisperTimeoutMs,
  });
  const memoryDirectory = resolvePath(Bun.env.MEMORY_DIR || "memory", projectDirectory);
  const memory = createMemoryStore(memoryDirectory);
  const searchClient = config.OLLAMA_API_KEY
    ? new Ollama({
        host: "https://ollama.com",
        headers: { Authorization: `Bearer ${config.OLLAMA_API_KEY}` },
      })
    : null;
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
    toolService: createToolService({
      searchClient,
      memory,
      gifSearch: createGifSearch({ apiKey: config.gifApiKey }),
    }),
    facts: config.facts,
    personality: config.personality,
    model: config.OLLAMA_MODEL,
    numCtx: config.OLLAMA_NUM_CTX,
    timeoutMs: config.OLLAMA_TIMEOUT,
    updateIntervalMs: 1200,
  });
  const discord = transports.discord
    ? createDiscordBot({
        config,
        assistant,
        onRequest,
        transcribe,
        generateVoice: voice.generate,
        memoryDirectory,
        onMusicStatus,
        externalClient: transports.discord,
      })
    : null;
  const telegram = transports.telegram
    ? createTelegramBot({
        config,
        assistant,
        onRequest,
        transcribe,
        generateVoice: voice.generate,
        api: transports.telegram,
      })
    : null;
  return {
    assistant,
    /** Resolve only after complete processing and final delivery of the accepted event. */
    async handle(event: RuntimeEvent) {
      if (event.kind === "discord-message") await discord?.receiveMessage(event.message);
      else if (event.kind === "discord-interaction")
        await discord?.handleInteraction(event.interaction);
      else await telegram?.handleUpdate(event.update);
    },
    /** Dispose only after the host drains accepted events during a restart; shutdown may cancel. */
    async dispose() {
      assistant.stopObserving();
      assistant.stopCurrentGeneration();
      modelClient.abort();
      searchClient?.abort();
      await Promise.all([voice.stop(), discord?.stop(), telegram?.stop()]);
    },
  };
}
