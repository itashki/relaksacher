/** @file Synchronize streamed model snapshots with Discord replies and their stop controls. */
import type { Message, ThreadChannel, ActionRowBuilder, ButtonBuilder } from "discord.js";
import { splitMessage, describeToolCall } from "./message.ts";

/** Create per-response delivery state; media-only answers remove temporary text messages. */
export function createDiscordDelivery(
  message: Message,
  newThread: ThreadChannel | null,
  stopRow: ActionRowBuilder<ButtonBuilder>,
) {
  let snapshot: import("../../types.ts").GenerationUpdate;
  let mediaDelivered = false;
  const replies: import("discord.js").Message[] = []; // отправленные сообщения бота
  const sent: { content: string; withButton: boolean }[] = []; // что сейчас показано в каждом сообщении

  // Приводит отправленные сообщения в соответствие с накопленным текстом.
  /**
   * Synchronize Discord messages with the latest accumulated generation state.
   * @param state Delivery snapshot.
   * @returns Resolves when messages have been sent or edited.
   */
  async function flush(state: import("../../types.ts").GenerationUpdate) {
    snapshot = state;
    const { text, final } = state;
    if (final && !text.trim() && mediaDelivered) {
      for (const reply of replies) await reply.delete();
      replies.length = 0;
      sent.length = 0;
      return;
    }
    const status = state.status ? describeToolCall(state.status) : "";
    let displayed = text;
    if (status) {
      displayed = `${text ? `${text}\n\n` : ""}*${status}*`;
    }
    if (state.modelAlias) {
      displayed = displayed
        ? `${displayed}\n\n-# ${state.modelAlias}`
        : `…\n\n-# ${state.modelAlias}`;
    }
    const chunks = splitMessage(displayed);
    // A temporary tool status can spill into an extra message.
    while (replies.length > chunks.length) {
      await replies.at(-1).delete();
      replies.pop();
      sent.pop();
    }
    for (let i = 0; i < chunks.length; i++) {
      const isLast = i === chunks.length - 1;
      const content = chunks[i].trim() ? chunks[i] : "…";
      const withButton = isLast && !final;

      const payload = {
        content,
        components: withButton ? [stopRow] : [],
        allowedMentions: { parse: [] as never[], repliedUser: false },
      };

      if (!replies[i]) {
        if (i === 0 && newThread) {
          // Первый кусок ответа идёт прямо в созданный тред.
          replies[i] = await newThread.send(payload);
        } else {
          const parent = i === 0 ? message : replies[i - 1];
          replies[i] = await parent.reply(payload);
        }
        sent[i] = { content, withButton };
      } else if (sent[i].content !== content || sent[i].withButton !== withButton) {
        await replies[i].edit(payload);
        sent[i] = { content, withButton };
      }
    }
  }

  return {
    flush,
    replies,
    get snapshot() {
      return snapshot;
    },
    markMediaDelivered() {
      mediaDelivered = true;
    },
  };
}
