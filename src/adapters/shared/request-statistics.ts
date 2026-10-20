/** @file Count messenger feature requests at routing boundaries, excluding ignored chatter. */
export { discordRecorder, telegramRecorder } from "./request-context.ts";
import type { RecordRequest, RequestFeature } from "../../core/statistics.ts";

/** Classify explicit non-roll commands; dice are counted by their immediate delivery handler. */
function commandFeature(text: string): RequestFeature | undefined {
  const command = text
    .trim()
    .match(/^!(\S+)(?:\s|$)/u)?.[1]
    .toLowerCase();
  switch (command) {
    case "voice":
    case "голос":
      return "voice";
    case "tts":
    case "озвучь":
      return "tts";
    case "transcribe":
    case "расшифруй":
      return /^!(?:transcribe|расшифруй)$/iu.test(text.trim()) ? "transcribe" : undefined;
    case "music":
    case "музыка":
      return "music";
    case "access":
    case "доступ":
      return "access";
  }
}

/** Count a routed Discord command or an automatic voice transcription once, before validation. */
export function recordDiscordRequest(text: string, voice: boolean, record?: RecordRequest) {
  const feature = commandFeature(text) ?? (voice ? "transcribe" : undefined);
  if (feature) record?.(feature);
}

/** Count only Telegram-supported commands addressed to this bot, or automatic voice transcription. */
export function recordTelegramRequest(
  text: string,
  voice: boolean,
  username: string,
  record?: RecordRequest,
) {
  const addressed = text.trim().match(/^!(?:voice|голос|transcribe|расшифруй)@(\w+)(?=\s|$)/iu);
  if (addressed && addressed[1].toLowerCase() !== username?.toLowerCase()) return;
  const clean = addressed ? text.trim().replace(`@${addressed[1]}`, "") : text;
  const feature = commandFeature(clean);
  if (feature === "voice" || feature === "transcribe") record?.(feature);
  else if (voice) record?.("transcribe");
}

/** Count music/settings component submissions; cancellation controls are not feature requests. */
export function recordDiscordInteraction(customId: string, record?: RecordRequest) {
  if (customId.startsWith("music:")) record?.("music");
  else if (customId.startsWith("access:")) record?.("access");
}
