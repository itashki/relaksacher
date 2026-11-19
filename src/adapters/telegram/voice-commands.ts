/** @file Telegram `!voice` and `!transcribe` commands: speech synthesis, transcription and error replies. */
import type { Message, User } from "@grammyjs/types";
import { splitText } from "./message.ts";
import { parseSpeechArguments } from "../speech/silero.ts";
import type { TelegramApi, VoiceRecording } from "../../types.ts";

/** Collaborators for voice commands; `me` is passed per call because it is resolved lazily. */
export interface TelegramVoiceDeps {
  api: TelegramApi;
  me: User;
  transcribe?: (load: () => Promise<Blob>) => Promise<string>;
  generateVoice?: (text: string, speaker?: string) => Promise<VoiceRecording>;
  remember: (message: Message) => void;
}

/**
 * Build the chat, thread and reply parameters shared by every reply payload.
 * @param message Message being answered.
 * @returns Base payload fields for sendMessage/sendVoice.
 */
function replyBase(message: Message) {
  return {
    chat_id: message.chat.id,
    ...(message.message_thread_id ? { message_thread_id: message.message_thread_id } : {}),
    reply_parameters: { message_id: message.message_id, allow_sending_without_reply: true },
  };
}

/**
 * Handle `!voice`, `!transcribe` and automatic voice transcription.
 * @param message Incoming message with its reply ancestor already resolved.
 * @param deps API, bot identity, optional speech services and history recorder.
 * @returns True when the message was fully handled (including usage errors and commands
 *   addressed to another bot); false when normal request processing should continue.
 */
export async function handleTelegramVoiceCommands(
  message: Message,
  deps: TelegramVoiceDeps,
): Promise<boolean> {
  const { api, me, transcribe, generateVoice, remember } = deps;
  const voiceCommand = (message.text ?? "")
    .trim()
    .match(/^!(?:voice|голос)(?:@(\w+))?(?:\s+([\s\S]*))?$/iu);
  if (voiceCommand && message.from && !message.from.is_bot) {
    if (voiceCommand[1] && voiceCommand[1].toLowerCase() !== me.username?.toLowerCase())
      return true;
    const base = replyBase(message);
    try {
      const argument = parseSpeechArguments(voiceCommand[2]);
      const text = (
        argument.text ||
        message.reply_to_message?.text ||
        message.reply_to_message?.caption ||
        ""
      ).trim();
      if (!text || text.length > 2000)
        throw new Error(
          "Используйте !voice [--speaker имя] <текст> или !voice ответом на сообщение, до 2000 символов.",
        );
      if (!generateVoice) throw new Error("Синтез голосовых сообщений недоступен.");
      const recording = await generateVoice(text, argument.speaker);
      await api("sendVoice", {
        ...base,
        voice: recording.audio,
        duration: Math.ceil(recording.duration),
      });
    } catch (error) {
      await api("sendMessage", {
        ...base,
        text: error instanceof Error ? error.message : "Не удалось отправить голосовое.",
      }).catch(() => {});
    }
    return true;
  }
  const transcriptionCommand = (message.text ?? "")
    .trim()
    .match(/^!(?:transcribe|расшифруй)(?:@(\w+))?$/iu);
  if (
    transcriptionCommand?.[1] &&
    transcriptionCommand[1].toLowerCase() !== me.username?.toLowerCase()
  )
    return true;
  const voiceMessage = transcriptionCommand ? message.reply_to_message : message;
  if (transcriptionCommand && message.from && !message.from.is_bot) {
    const error = !voiceMessage?.voice
      ? "Используйте !transcribe ответом на голосовое сообщение."
      : !transcribe
        ? "Расшифровка голосовых сообщений недоступна."
        : undefined;
    if (error) {
      await api("sendMessage", { ...replyBase(message), text: error });
      return true;
    }
  }
  if (voiceMessage?.voice && message.from && !message.from.is_bot && transcribe) {
    let text: string;
    let transcript: string | undefined;
    try {
      transcript = await transcribe(() => api.downloadVoice(voiceMessage.voice!.file_id));
      text = "🎙\n" + transcript;
    } catch {
      text =
        "Не удалось расшифровать голосовое. Проверьте доступность Whisper и попробуйте ещё раз.";
    }
    for (const chunk of splitText(text))
      await api("sendMessage", { ...replyBase(message), text: chunk });
    if (transcript) remember({ ...voiceMessage, text: transcript });
    return true;
  }
  return false;
}
