/** @file Discord `!describe` / `!опиши` command: image and video attachment descriptions with a per-channel video cache. */
import type { Message } from "discord.js";
import type { MediaDescriber } from "../../core/media/index.ts";
import type { createVideoDescriptionStore } from "../../core/memory/video-descriptions.ts";
import { downloadImage } from "../shared/images.ts";
import { downloadVideo } from "../shared/video.ts";
import { describeAuthor, imageFiles, splitMessage, videoFiles } from "./message.ts";

const CDN_HOSTS = ["cdn.discordapp.com", "media.discordapp.net"];

/** Collaborators of the describe command. */
export interface DiscordDescribeDeps {
  describer?: MediaDescriber;
  store?: ReturnType<typeof createVideoDescriptionStore>;
  /** Resolve the replied-to message of the command; may reject when it was deleted. */
  fetchReference: () => Promise<Message | null>;
  /** Image loader returning base64; defaults to the CDN-restricted `downloadImage`. */
  loadImage?: (url: string) => Promise<string>;
  /** Video loader; defaults to the CDN-restricted `downloadVideo`. */
  loadVideo?: (url: string) => Promise<Blob>;
}

/**
 * Handle `!describe` / `!опиши` for image and video attachments of the message or of its reply target.
 * Video results are cached under `discord_<channelId>`, the same chat id `index.ts` gives sessions,
 * and a question disables the cache because the answer then depends on it.
 * Out of scope: Discord has no video-note type, so there is no auto-description and no
 * `read_video_descriptions` tool capability; the store is only written here.
 * @param message Incoming message.
 * @param deps Describer, optional store, reference resolver and loaders.
 * @returns True when the message was a describe command (including usage and error replies);
 *   false when normal processing should continue.
 */
export async function handleDiscordDescribeCommand(
  message: Message,
  { describer, store, fetchReference, loadImage, loadVideo }: DiscordDescribeDeps,
): Promise<boolean> {
  const command = message.content?.trim().match(/^!(?:describe|опиши)(?:\s+([\s\S]*))?$/iu);
  if (!command) return false;
  const question = command[1]?.trim() || undefined;
  let prefix = "🖼 ";
  let text: string;
  try {
    const own = [...imageFiles(message), ...videoFiles(message)].length;
    const target = own ? message : await fetchReference().catch((): null => null);
    const images = target ? imageFiles(target) : [];
    const video = target && !images.length ? videoFiles(target)[0] : undefined;
    if (!target || (!images.length && !video))
      throw new Error("Используйте !describe ответом на изображение или видео.");
    if (!describer) throw new Error("Описание изображений и видео недоступно.");
    if (video) {
      prefix = "🎬 ";
      if (!describer.videoAvailable()) throw new Error("Описание видео недоступно.");
      const chat = `discord_${message.channel.id}`;
      const cached = question ? null : await store?.findByFile(chat, video.id);
      if (cached) text = cached.description;
      else {
        const result = await describer.describeVideo(
          () =>
            (loadVideo ?? ((url) => downloadVideo(url, { allowedHosts: CDN_HOSTS })))(video.url),
          question,
        );
        text = result.description;
        if (!question)
          await store?.save(chat, {
            messageId: target.id,
            fileUniqueId: video.id,
            kind: "video",
            author: describeAuthor(target),
            at: (target.createdAt ?? new Date()).toISOString(),
            description: text,
            model: result.model,
          });
      }
    } else {
      const load = loadImage ?? ((url: string) => downloadImage(url, { allowedHosts: CDN_HOSTS }));
      text = await describer.describeImage(await load(images[0]), question);
    }
  } catch (error) {
    prefix = "";
    const reason = error instanceof Error ? error.message : "";
    // Only Russian, already sanitized messages from our own modules reach the chat.
    const known = /^[А-Яа-яЁё]/.test(reason);
    text = known ? reason : "Не удалось описать медиа. Попробуйте ещё раз.";
    if (!known) console.warn("Discord media description failed:", reason);
  }
  for (const content of splitMessage(prefix + text, 1900))
    await message
      .reply({ content, allowedMentions: { parse: [], repliedUser: false } })
      .catch(() => {});
  return true;
}
