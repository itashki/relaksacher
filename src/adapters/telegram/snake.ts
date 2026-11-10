/** @file Self-contained Snake widget and Telegram command delivery. */
import type { Message } from "@grammyjs/types";
import type { TelegramApi } from "../../types.ts";

import snakeHtml from "./snake.html" with { type: "text" };

/** Self-contained Snake UI; shared leaderboard data comes from Telegram. */
// Bun types HTML imports as bundles even when the text loader is explicit.
export const SNAKE_HTML = snakeHtml as unknown as string;

/** Consume an addressed !snake command, sending a private-chat widget or explanation. */
export async function handleTelegramSnake(
  message: Message,
  username: string,
  api: (...args: Parameters<TelegramApi>) => ReturnType<TelegramApi>,
  sendWidget = (payload: Record<string, unknown>) =>
    api("sendWidget", { ...payload, html: SNAKE_HTML }),
): Promise<boolean> {
  const command = message.text?.trim().match(/^!snake(?:@(\w+))?$/iu);
  if (!command || (command[1] && command[1].toLowerCase() !== username.toLowerCase())) return false;
  const base = {
    chat_id: message.chat.id,
    ...(message.message_thread_id ? { message_thread_id: message.message_thread_id } : {}),
    reply_parameters: { message_id: message.message_id, allow_sending_without_reply: true },
  };
  if (message.chat.type !== "private") {
    await api("sendMessage", {
      ...base,
      text: `Виджеты Telegram пока доступны только в личных чатах. Откройте @${username} и отправьте !snake.`,
    });
  } else {
    try {
      await sendWidget(base);
    } catch (error) {
      console.warn("Telegram snake widget failed:", String(error));
      await api("sendMessage", {
        ...base,
        text: "Не удалось отправить змейку. Попробуйте !snake ещё раз; для игры нужен Telegram с поддержкой виджетов.",
      });
    }
  }
  return true;
}
