/** @file Immediate dice command delivery without model invocation or mention requirements. */
import { parseRollCommand, rollDice } from "../../core/dice.ts";
import { splitMessage } from "../discord/message.ts";

/** Reply to a Discord dice command and report whether it was consumed. */
export async function handleDiscordRoll(message: import("discord.js").Message) {
  const command = parseRollCommand(message.content ?? "");
  if (!command) return false;
  if (command.username) return true;
  for (const content of splitMessage(rollDice(command.argument), 1900))
    await message.reply({ content, allowedMentions: { parse: [], repliedUser: false } });
  return true;
}

/** Reply in the originating Telegram topic; ignore commands addressed to another bot. */
export async function handleTelegramRoll(
  message: import("@grammyjs/types").Message,
  username: string,
  api: import("../../types.ts").TelegramApi,
) {
  const command = parseRollCommand(message.text ?? "");
  if (!command || !message.from || message.from.is_bot) return false;
  if (command.username && command.username.toLowerCase() !== username?.toLowerCase()) return true;
  for (const text of splitMessage(rollDice(command.argument), 1900))
    await api("sendMessage", {
      chat_id: message.chat.id,
      ...(message.message_thread_id ? { message_thread_id: message.message_thread_id } : {}),
      reply_parameters: { message_id: message.message_id, allow_sending_without_reply: true },
      text,
    });
  return true;
}
