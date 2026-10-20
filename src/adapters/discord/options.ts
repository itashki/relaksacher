/** @file Public construction dependencies for the Discord adapter. */
import type { Client } from "discord.js";

/** Inject services and optional host telemetry without opening a gateway connection. */
export type DiscordBotOptions = {
  config: import("../../types.ts").AppConfig;
  assistant: import("../../types.ts").Assistant;
  generateVoice?: (
    text: string,
    speaker?: string,
  ) => Promise<import("../../types.ts").VoiceRecording>;
  transcribe?: (load: () => Promise<Blob>) => Promise<string>;
  memoryDirectory: string;
  onMusicStatus?: (statuses: import("../../core/music/status.ts").MusicStatus[]) => void;
  /** Keep the host gateway connected across a managed runtime restart. */
  externalClient?: Client;
  loadImage?: (arg0: string) => Promise<string>;
  onRequest?: import("../../core/statistics.ts").RecordRequest;
};
