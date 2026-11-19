/** @file Streamed Telegram reply delivery: throttled sends/edits, status labels and stop-button cleanup. */
import { formatTelegramChunks } from "./format.ts";

/** Human-readable status shown under the answer while a tool runs. */
const TOOL_STATUS: Record<string, string> = {
  search_images: "🖼 Ищу картинку",
  send_image: "🖼 Отправляю картинку",
  read_history: "📜 Читаю историю чата",
  web_search: "🔍 Ищу в интернете",
  web_fetch: "🌐 Читаю страницу",
  enable_thinking: "💭 Обдумываю запрос",
  remember: "🧠 Запоминаю",
  forget: "🧠 Удаляю запись",
};

/**
 * Create the delivery state for one Telegram generation.
 * @param options.api Telegram API caller.
 * @param options.message Request message that replies are attached to.
 * @param options.config Application config (`telegramUpdateIntervalMs` throttles intermediate edits).
 * @param options.stopId Identifier embedded in the stop button callback data.
 * @returns `render` sends or edits reply messages for a snapshot (non-final, non-immediate
 *   snapshots are throttled; transient non-final edit errors are postponed, others thrown);
 *   `markMediaDelivered` records that media was sent so an empty final text deletes placeholders;
 *   `replies` is the live array of sent messages; `finalized()` tells whether the final text is
 *   delivered; `clearStopButtons` removes remaining stop markup, swallowing errors.
 */
export function createTelegramReplyDelivery({
  api,
  message,
  config,
  stopId,
}: {
  api: import("../../types.ts").TelegramApi;
  message: import("@grammyjs/types").Message;
  config: import("../../types.ts").AppConfig;
  stopId: string;
}) {
  const replies: import("@grammyjs/types").Message.TextMessage[] = [];
  const sent: string[] = [];
  const base = {
    chat_id: message.chat.id,
    ...(message.message_thread_id ? { message_thread_id: message.message_thread_id } : {}),
  };
  let lastRenderedAt = -Infinity;
  let finalized = false;
  let mediaDelivered = false;

  /**
   * Render the latest snapshot, throttling intermediate edits only.
   * @param state Accumulated answer.
   * @param immediate Bypass the ordinary render interval.
   * @returns Delivery completion.
   */
  async function render(
    state: import("../../types.ts").GenerationUpdate,
    immediate: boolean = false,
  ) {
    if (state.final && !state.text.trim() && mediaDelivered) {
      for (const reply of replies) {
        await api("deleteMessage", { chat_id: message.chat.id, message_id: reply.message_id });
      }
      replies.length = 0;
      sent.length = 0;
      finalized = true;
      return;
    }
    if (
      !state.final &&
      !immediate &&
      replies.length &&
      Date.now() - lastRenderedAt < (config.telegramUpdateIntervalMs ?? 5000)
    )
      return;
    lastRenderedAt = Date.now();
    const footer = state.modelAlias ? `\n\n· ${state.modelAlias}` : "";
    let text = state.text || "…";
    if (state.status) {
      text += `\n\n${TOOL_STATUS[state.status.function.name] ?? "⚙️ Использую инструмент"}`;
    }
    const chunks = formatTelegramChunks(text, state.modelAlias);
    // Keep the number of messages stable if temporary thinking/status disappears.
    while (chunks.length < replies.length) chunks.push(`·${footer}`);
    for (let i = 0; i < chunks.length; i++) {
      const markup = {
        inline_keyboard:
          !state.final && i === chunks.length - 1
            ? [[{ text: "⏹ Остановить", callback_data: `stop:${stopId}` }]]
            : [],
      };
      const payload = {
        text: chunks[i],
        parse_mode: "HTML",
        reply_markup: markup,
        link_preview_options: { is_disabled: true },
      };
      const fingerprint = JSON.stringify(payload);
      if (!replies[i]) {
        replies[i] = await api("sendMessage", {
          ...base,
          ...payload,
          reply_parameters: { message_id: message.message_id, allow_sending_without_reply: true },
        });
      } else if (sent[i] !== fingerprint) {
        try {
          await api("editMessageText", {
            chat_id: message.chat.id,
            message_id: replies[i].message_id,
            ...payload,
          });
        } catch (error) {
          if (!error.message.includes("message is not modified")) {
            if (!state.final && error.transient) {
              console.warn("Telegram edit postponed:", String(error));
              return; // Leave sent unchanged; the next snapshot retries the latest text.
            }
            throw error;
          }
        }
      }
      sent[i] = fingerprint;
    }
    if (state.final) finalized = true;
  }

  return {
    render,
    replies,
    /** Record that media was sent, so an empty final text removes the placeholders. */
    markMediaDelivered() {
      mediaDelivered = true;
    },
    /** @returns Whether the final answer has been delivered. */
    finalized: () => finalized,
    /**
     * Remove stop buttons from unfinished replies, even after failures; errors are swallowed.
     * @returns Cleanup completion.
     */
    async clearStopButtons() {
      for (const reply of finalized ? [] : replies)
        await api("editMessageReplyMarkup", {
          chat_id: message.chat.id,
          message_id: reply.message_id,
          reply_markup: { inline_keyboard: [] },
        }).catch(() => {});
    },
  };
}
