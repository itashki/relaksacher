/** @file Compose model clients, stores and adapters around process-owned messenger connections. */
import { Ollama } from "ollama";
import { createVoiceSynthesizer } from "../adapters/speech/silero.ts";
import { createLlamaClient } from "../core/llama/client.ts";
import { createGigaamServer } from "../core/speech/gigaam-server.ts";
import { createLlamaServer, createModelServers, gigaamKey } from "../core/llama/servers.ts";
import { createTranscriber } from "../core/speech/transcription.ts";
import { createMemoryStore } from "../core/memory/index.ts";
import { createGifSearch } from "../core/tools/gif-search.ts";
import { createToolService } from "../core/tools/index.ts";
import { createSupervisor } from "../core/assistant/supervisor.ts";
import { createImageDescriber } from "../core/media/image-description.ts";
import { createVideoDescriber } from "../core/media/video-description.ts";
import { createMediaDescriber } from "../core/media/index.ts";
import { createTranslator } from "../core/media/translate.ts";
import { createAssistant } from "../core/assistant/index.ts";
import { createTelegramBot } from "../adapters/telegram/index.ts";
import { createDiscordBot } from "../adapters/discord/index.ts";
import { createVideoDescriptionStore } from "../core/memory/video-descriptions.ts";
import { resolvePath } from "../core/paths.ts";
import { projectDirectory } from "../core/project.ts";
import type { AppConfig } from "../types.ts";
import type { RuntimeEvent, RuntimeTransports } from "./contracts.ts";

/** Construct fresh handlers without logging in, polling, or consuming incoming events. */
export function createApplication(
  config: AppConfig,
  transports: RuntimeTransports,
  onMusicStatus: Parameters<typeof createDiscordBot>[0]["onMusicStatus"],
  onRequest?: import("../core/statistics.ts").RecordRequest,
) {
  const voice = createVoiceSynthesizer({ silero: config.silero });
  const visionModel = config.LLAMA_VISION_MODEL ?? config.LLAMA_MODEL;
  // One model process at a time: llama-server per GGUF path, or GigaAM (see core/llama/servers.ts).
  const servers = createModelServers({
    create: (key) =>
      key === gigaamKey
        ? createGigaamServer(config.gigaam)
        : createLlamaServer({
            model: key,
            mmproj: key === visionModel ? config.LLAMA_MMPROJ : undefined,
            numCtx: config.OLLAMA_NUM_CTX,
          }),
  });
  const transcribe = createTranscriber({
    url: config.transcriptionBackend === "gigaam" ? config.gigaam?.url : config.whisperUrl,
    timeoutMs: config.whisperTimeoutMs,
    servers: config.transcriptionBackend === "gigaam" ? servers : undefined,
  });
  const memoryDirectory = resolvePath(Bun.env.MEMORY_DIR || "memory", projectDirectory);
  const memory = createMemoryStore(memoryDirectory);
  const videoDescriptions = createVideoDescriptionStore(
    resolvePath("video-descriptions", memoryDirectory),
  );
  const searchClient = config.OLLAMA_API_KEY
    ? new Ollama({
        host: "https://ollama.com",
        headers: { Authorization: `Bearer ${config.OLLAMA_API_KEY}` },
      })
    : null;
  const modelClient = createLlamaClient({ servers });
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
    model: config.LLAMA_MODEL,
    visionModel: config.LLAMA_VISION_MODEL,
    numCtx: config.OLLAMA_NUM_CTX,
    timeoutMs: config.OLLAMA_TIMEOUT,
    updateIntervalMs: 1200,
  });
  const describer = createMediaDescriber({
    image: createImageDescriber({
      modelClient,
      model: visionModel,
      timeoutMs: config.OLLAMA_TIMEOUT,
      runExclusive: assistant.runExclusive,
    }),
    video: createVideoDescriber({
      modelClient,
      model: visionModel,
      timeoutMs: config.OLLAMA_TIMEOUT,
      available: Boolean(config.LLAMA_MMPROJ),
    }),
    translator: createTranslator({
      modelClient,
      model: config.LLAMA_MODEL,
      timeoutMs: config.OLLAMA_TIMEOUT,
      runExclusive: assistant.runExclusive,
    }),
  });
  const discord = transports.discord
    ? createDiscordBot({
        config,
        assistant,
        onRequest,
        transcribe,
        describer,
        videoDescriptions,
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
        describer,
        videoDescriptions,
        api: transports.telegram,
        memoryDirectory,
      })
    : null;
  return {
    assistant,
    /** Image and video description facade. */
    describer,
    /** Persistent per-chat video descriptions. */
    videoDescriptions,
    /** Resolve only after complete processing and final delivery of the accepted event. */
    async handle(event: RuntimeEvent) {
      if (event.kind === "discord-message") await discord?.receiveMessage(event.message);
      else if (event.kind === "discord-interaction")
        await discord?.handleInteraction(event.interaction);
      else await telegram?.handleUpdate(event.update);
    },
    /** Stop model work and release adapters and voice synthesis during process shutdown. */
    async dispose() {
      assistant.stopObserving();
      assistant.stopCurrentGeneration();
      searchClient?.abort();
      await Promise.all([voice.stop(), discord?.stop(), telegram?.stop()]);
      await servers.dispose();
    },
  };
}
