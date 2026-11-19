/**
 * @file Build the explicit Telegram reply chain and the model conversation from it,
 * and decide whether a message addresses the bot.
 */
import type { Message } from "@grammyjs/types";
import { cleanTelegramCommands, imageFiles, author, rememberTelegramImages } from "./message.ts";
import { parseCommands } from "../../core/text.ts";

/** Maximum number of messages (including the request itself) in one reply chain. */
export const MAX_REPLY_CHAIN = 30;

/**
 * Check whether a message pings the bot (mention) or uses a /think command.
 * @param message Message whose `text` and `entities` are already normalized.
 * @param me Bot identity.
 * @returns True when the bot is explicitly addressed by an entity.
 */
export function isTelegramBotAddressed(
  message: Message,
  me: { id: number; username?: string },
): boolean {
  const text = message.text ?? "";
  const username = `@${me.username}`.toLowerCase();
  return (message.entities ?? []).some((entity) => {
    const part = text.slice(entity.offset, entity.offset + entity.length).toLowerCase();
    if (entity.type === "text_mention") return entity.user?.id === me.id;
    if (entity.type === "mention") return part === username;
    if (entity.type !== "bot_command") return false;
    return ["/think"].some(
      (name) => part === name || part === `${name}@${me.username}`.toLowerCase(),
    );
  });
}

/**
 * Walk explicit reply ancestors of a message, oldest first, ending with the message.
 * The walk is bounded to {@link MAX_REPLY_CHAIN} messages and protected against cycles.
 * Ancestors without text, caption or images, or without a sender, are skipped but
 * still followed.
 * @param message Current request.
 * @param past Cached room history used to find deeper `reply_to_message` links.
 * @param resolve Resolves a parent to its fullest known version (e.g. merged batch).
 * @returns Chain messages with text normalized and image files remembered.
 */
export function collectTelegramReplyChain(
  message: Message,
  past: Message[],
  resolve: (parent: Message) => Message,
): Message[] {
  const chain = [message];
  const seen = new Set([message.message_id]);
  let parent: Message | undefined = message.reply_to_message;
  while (parent && !seen.has(parent.message_id) && chain.length < MAX_REPLY_CHAIN) {
    parent = resolve(parent);
    if (seen.has(parent.message_id)) break;
    seen.add(parent.message_id);
    if ((parent.text || parent.caption || imageFiles(parent).length) && parent.from) {
      const entry = { ...parent, text: parent.text ?? parent.caption ?? "Изображение." };
      rememberTelegramImages(entry, imageFiles(parent));
      chain.unshift(entry);
    }
    const id = parent.message_id;
    parent =
      past.find((entry) => entry.message_id === id)?.reply_to_message ?? parent.reply_to_message;
  }
  return chain;
}

/**
 * Map chain messages to model conversation entries.
 * Bot messages become assistant turns; others become user turns with an author label,
 * a JSON quote block when present, no leading bot mention and no bot commands.
 * @param messages Chain from {@link collectTelegramReplyChain}.
 * @param me Bot identity.
 * @returns Conversation entries in the same order.
 */
export function buildTelegramConversation(
  messages: Message[],
  me: { id: number; username?: string },
): { role: "assistant" | "user"; content: string }[] {
  return messages.map((entry) => {
    if (entry.from.id === me.id) return { role: "assistant", content: entry.text };
    let text = entry.text;
    const offset = text.length - text.trimStart().length;
    const leadingMention = (entry.entities ?? entry.caption_entities ?? []).find(
      (entity) =>
        entity.offset === offset &&
        ((entity.type === "text_mention" && entity.user.id === me.id) ||
          (entity.type === "mention" &&
            text.slice(offset, offset + entity.length).toLowerCase() ===
              `@${me.username}`.toLowerCase())),
    );
    if (leadingMention) text = text.slice(offset + leadingMention.length).trimStart();
    else {
      const username = text.trimStart().match(/^@(\w+)/u);
      if (username && username[1].toLowerCase() === me.username?.toLowerCase()) {
        text = text.trimStart().slice(username[0].length).trimStart();
      }
    }
    const quote = entry.quote?.text
      ? `Цитируемый фрагмент (JSON): ${JSON.stringify({
          text: entry.quote.text,
          messageId: entry.reply_to_message?.message_id ?? entry.external_reply?.message_id ?? null,
          position: entry.quote.position,
          manuallySelected: entry.quote.is_manual === true,
        })}\nТекст реплики:\n`
      : "";
    return {
      role: "user",
      content: `[Автор: ${author(entry.from)}]\n${quote}${parseCommands(cleanTelegramCommands(text, me.username)).content}`,
    };
  });
}
