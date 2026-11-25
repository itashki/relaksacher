/** @file Telegram `!describe` / `!опиши` command: image and video descriptions with a per-chat video cache. */
import type { Message, User } from "@grammyjs/types";
import { author, imageFiles, splitText } from "./message.ts";
import { extractAudio } from "../shared/video.ts";
import type { MediaDescriber } from "../../core/media/index.ts";
import type { createVideoDescriptionStore } from "../../core/memory/video-descriptions.ts";
import type { TelegramApi, VideoDescription } from "../../types.ts";

/** Collaborators for the describe command; `me` is passed per call because it is resolved lazily. */
export interface TelegramMediaDeps {
  api: TelegramApi;
  me: User;
  describer?: MediaDescriber;
  /** Speech recognizer; when set, speech in described videos is appended to their description. */
  transcribe?: (load: () => Promise<Blob>) => Promise<string>;
  store?: ReturnType<typeof createVideoDescriptionStore>;
  /** Chat id under which video descriptions are stored. */
  chatId: (message: Message) => string;
  remember: (message: Message) => void;
  /** Auto-description mode for video notes; an absent value behaves as `silent`. */
  videoNoteMode?: "off" | "silent" | "reply";
}

/** Video-like attachment of a message. */
type VideoTarget = {
  fileId: string;
  fileUniqueId: string;
  kind: "video_note" | "video" | "animation";
  durationSec?: number;
};

/**
 * Find the video, video note, animation or MP4 document carried by a message.
 * @param message Telegram message.
 * @returns File identifiers and kind, or undefined when the message has no video.
 */
export function videoTarget(message: Message): VideoTarget | undefined {
  const pick = (
    kind: VideoTarget["kind"],
    file?: { file_id: string; file_unique_id: string; duration?: number },
  ) =>
    file
      ? {
          fileId: file.file_id,
          fileUniqueId: file.file_unique_id,
          kind,
          durationSec: file.duration,
        }
      : undefined;
  return (
    pick("video_note", message.video_note) ??
    pick("video", message.video) ??
    pick("animation", message.animation) ??
    (message.document?.mime_type === "video/mp4" ? pick("video", message.document) : undefined)
  );
}

/**
 * Build the chat, thread and reply parameters shared by every reply payload.
 * @param message Message being answered.
 * @returns Base payload fields for sendMessage.
 */
function replyBase(message: Message) {
  return {
    chat_id: message.chat.id,
    ...(message.message_thread_id ? { message_thread_id: message.message_thread_id } : {}),
    reply_parameters: { message_id: message.message_id, allow_sending_without_reply: true },
  };
}

/** Label under which a described video is cached in reply chains and history. */
export const videoLabel = (description: string) => `[Видеосообщение, описание: ${description}]`;

/**
 * Describe a video target, reusing a stored description of the same file when allowed.
 * On a fresh description it saves the entry and remembers the target message with a labeled text.
 * @param target Message carrying the video.
 * @param video File descriptor of that message.
 * @param deps Command collaborators; `describer` must be present.
 * @param reuse Whether a stored entry of the same `file_unique_id` may be returned.
 * @param question Optional prompt for the video model.
 * @param context Message whose chat and thread own the cached copy.
 * @param translate Whether to translate to Russian through the shared queue; false inside a session.
 * @returns Description text.
 * @throws {Error} When the download or description fails.
 */
async function describeVideoTarget(
  target: Message,
  video: VideoTarget,
  deps: TelegramMediaDeps,
  reuse: boolean,
  question: string | undefined,
  context: Message,
  translate = true,
) {
  const { api, describer, store, chatId, remember } = deps;
  const chat = chatId(context);
  const cached = reuse ? await store?.findByFile(chat, video.fileUniqueId) : null;
  if (cached) return cached.description;
  if (!api.downloadVideo) throw new Error("Скачивание видео недоступно.");
  const blob = await api.downloadVideo(video.fileId);
  console.info(
    `[video-speech] transcribe=${typeof deps.transcribe === "function"} blob=${blob.size} reuse=${reuse} translate=${translate}`,
  );
  const [described, speech] = await Promise.all([
    describer.describeVideo(() => Promise.resolve(blob), question, { translate }),
    // No audio track or no recognized speech just means there is nothing to add.
    deps
      .transcribe?.(async () => {
        const audio = await extractAudio(blob);
        console.info(`[video-speech] audio=${audio?.size ?? 0}`);
        return audio ?? new Blob();
      })
      .catch((error: unknown) => {
        console.warn(
          "Telegram video speech transcription failed:",
          error instanceof Error ? error.message : error,
        );
        return "";
      }) ?? "",
  ]);
  console.info(`[video-speech] speech=${speech.length}`);
  const result = speech
    ? { ...described, description: `${described.description}\nРечь в видео: ${speech}` }
    : described;
  if (reuse)
    await store?.save(chat, {
      messageId: String(target.message_id),
      fileUniqueId: video.fileUniqueId,
      kind: video.kind,
      author: target.from ? author(target.from) : "неизвестно",
      at: new Date((target.date || Date.now() / 1000) * 1000).toISOString(),
      durationSec: video.durationSec,
      description: result.description,
      model: result.model,
    });
  remember({
    ...target,
    chat: context.chat,
    message_thread_id: context.message_thread_id,
    text: videoLabel(result.description),
  });
  return result.description;
}

/** Cap for an on-demand description made inside a model session, separate from `SMOLVLM_TIMEOUT_MS`. */
export const ON_DEMAND_TIMEOUT_MS = 120_000;

/**
 * Describe a cached video message for the `read_video_descriptions` tool and return its stored entry.
 * Runs inside a model session that holds the shared Ollama queue, so it calls only `describeVideo`
 * (the SmolVLM process) and never translates, since both `describeImage` and the translator
 * would deadlock on that queue; the stored text is therefore English in this path.
 * @param target Cached message that may carry a video.
 * @param deps Command collaborators; `describer` and `store` are required for a result.
 * @param context Message whose chat and thread own the stored entry.
 * @param timeoutMs Cap on the wait; the description may still finish and be stored afterwards.
 * @returns The stored entry, or null when the message has no video, the describer is unavailable,
 *   the description failed, or it was not ready within the cap.
 */
export async function describeVideoOnDemand(
  target: Message,
  deps: TelegramMediaDeps,
  context: Message,
  timeoutMs = ON_DEMAND_TIMEOUT_MS,
): Promise<VideoDescription | null> {
  const video = videoTarget(target);
  if (!video || !deps.store || !deps.describer?.videoAvailable()) return null;
  const chat = deps.chatId(context);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const work = describeVideoTarget(target, video, deps, true, undefined, context, false).then(
    async () =>
      (await deps.store.get(chat, String(target.message_id))) ??
      (await deps.store.findByFile(chat, video.fileUniqueId)),
    (error): null => {
      console.warn("Telegram on-demand video description failed:", error?.message ?? error);
      return null;
    },
  );
  const limit = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), timeoutMs);
  });
  try {
    return await Promise.race([work, limit]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Describe a video note (circle) sent without a command, store it and label it in history.
 * Regular videos, animations and documents are never auto-described. Failures are logged;
 * only `reply` mode answers them, with a short error.
 * @param message Incoming message.
 * @param deps Command collaborators.
 * @returns True when the message was a video note that was handled; false to continue normally.
 */
async function describeVideoNote(message: Message, deps: TelegramMediaDeps): Promise<boolean> {
  const { describer, videoNoteMode = "reply", remember } = deps;
  const video = message.video_note ? videoTarget(message) : undefined;
  if (!video || !message.from || message.from.is_bot) return false;
  if (videoNoteMode === "off" || !describer?.videoAvailable()) return false;
  let text: string;
  try {
    text = await describeVideoTarget(message, video, deps, true, undefined, message);
    // A reused description skips the save/remember path above, so label this message too.
    remember({ ...message, text: videoLabel(text) });
    if (videoNoteMode !== "reply") return true;
    text = `🎬 ${text}`;
  } catch (error) {
    console.warn(
      "Telegram video note description failed:",
      error instanceof Error ? error.message : error,
    );
    if (videoNoteMode !== "reply") return true;
    text = "Не удалось описать видеосообщение.";
  }
  for (const chunk of splitText(text))
    await deps.api("sendMessage", { ...replyBase(message), text: chunk }).catch(() => {});
  return true;
}

/**
 * Handle `!describe` / `!опиши` for images and videos, and auto-describe video notes.
 * Without a command, only a `video_note` from a non-bot sender is described (per
 * `videoNoteMode`); regular videos fall through unchanged.
 * A question given with the command disables the stored-description cache for videos,
 * because the answer then depends on the question.
 * @param message Incoming message with its reply ancestor already resolved.
 * @param deps API, bot identity, optional describer and store, chat id mapping and history recorder.
 * @returns True when the message was handled (including usage errors and commands addressed to
 *   another bot); false when normal request processing should continue.
 */
export async function handleTelegramMediaCommands(
  message: Message,
  deps: TelegramMediaDeps,
): Promise<boolean> {
  const { api, me, describer } = deps;
  const command = (message.text ?? message.caption ?? "")
    .trim()
    .match(/^!(?:describe|опиши)(?:@(\w+))?(?:\s+([\s\S]*))?$/iu);
  if (!command) return describeVideoNote(message, deps);
  if (!message.from || message.from.is_bot) return false;
  if (command[1] && command[1].toLowerCase() !== me.username?.toLowerCase()) return true;
  const question = command[2]?.trim() || undefined;
  const target =
    imageFiles(message).length || videoTarget(message) ? message : message.reply_to_message;
  const images = target ? imageFiles(target) : [];
  const video = target && !images.length ? videoTarget(target) : undefined;
  let prefix = "🖼 ";
  let text: string;
  try {
    if (!target || (!images.length && !video))
      throw new Error("Используйте !describe ответом на изображение или видео.");
    if (!describer) throw new Error("Описание изображений и видео недоступно.");
    if (video) {
      prefix = "🎬 ";
      if (!describer.videoAvailable()) throw new Error("Описание видео недоступно.");
      text = await describeVideoTarget(target, video, deps, !question, question, message);
    } else {
      text = await describer.describeImage(await api.downloadImage(images[0]), question);
    }
  } catch (error) {
    prefix = "";
    const reason = error instanceof Error ? error.message : "";
    // Only Russian, already sanitized messages from our own modules reach the chat.
    const known = /^[А-Яа-яЁё]/.test(reason);
    text = known ? reason : "Не удалось описать медиа. Попробуйте ещё раз.";
    if (!known) console.warn("Telegram media description failed:", reason);
  }
  for (const chunk of splitText(prefix + text))
    await api("sendMessage", { ...replyBase(message), text: chunk }).catch(() => {});
  return true;
}
