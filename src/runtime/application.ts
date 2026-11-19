/** @file Compose model clients, stores and adapters around process-owned messenger connections. */
import { Ollama } from "ollama";
import { createVoiceSynthesizer } from "../adapters/speech/silero.ts";
import { createTranscriber } from "../core/speech/transcription.ts";
import { createMemoryStore } from "../core/memory/index.ts";
import { createGifSearch } from "../core/tools/gif-search.ts";
import { createToolService } from "../core/tools/index.ts";
import { createSupervisor } from "../core/assistant/supervisor.ts";
import { createImageDescriber } from "../core/media/image-description.ts";
import { createMediaDescriber } from "../core/media/index.ts";
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
  videoDescriber?: import("../core/media/video-description.ts").VideoDescriber,
) {
  const voice = createVoiceSynthesizer({ silero: config.silero });
  const transcribe = createTranscriber({
    url: config.transcriptionBackend === "gigaam" ? config.gigaam?.url : config.whisperUrl,
    timeoutMs: config.whisperTimeoutMs,
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
    visionModel: config.OLLAMA_VISION_MODEL,
    numCtx: config.OLLAMA_NUM_CTX,
    timeoutMs: config.OLLAMA_TIMEOUT,
    updateIntervalMs: 1200,
  });
  const describer = createMediaDescriber({
    image: createImageDescriber({
      modelClient,
      model: config.OLLAMA_VISION_MODEL ?? config.OLLAMA_MODEL,
      timeoutMs: config.OLLAMA_TIMEOUT,
      runExclusive: assistant.runExclusive,
    }),
    video: videoDescriber,
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
        describer,
        videoDescriptions,
        api: transports.telegram,
        memoryDirectory,
      })
    : null;
  return {
    assistant,
    /** Image and video description facade; not yet passed to adapters. */
    describer,
    /** Persistent per-chat video descriptions; adapters do not use it yet. */
    videoDescriptions,
    /** Stored for later steps; adapters do not use the video describer yet. */
    videoDescriber,
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
      modelClient.abort();
      searchClient?.abort();
      await Promise.all([voice.stop(), discord?.stop(), telegram?.stop()]);
    },
  };
}
