/** @file Read bounded Discord channel/thread history without treating it as new requests. */
import type { Client, Message } from "discord.js";
import { describeAuthor } from "./message.ts";
import type { createTranscriptHistory } from "../../core/memory/transcript-history.ts";

/** Fetch history before the current message, sharing the limit between a thread and its parent. */
export async function readDiscordHistory(
  message: Message,
  client: Client,
  transcripts: ReturnType<typeof createTranscriptHistory>,
  limit: number,
) {
  const entries = await message.channel.messages.fetch({ limit, before: message.id });
  const formatEntries = (
    entries: Map<string, import("discord.js").Message>,
    channel: { id: string; name?: string },
  ) =>
    transcripts.normalize(
      [...entries.values()]
        .reverse()
        .filter((entry) => !entry.author.bot || entry.author.id === client.user.id)
        .map((entry) => ({
          id: entry.id,
          author: describeAuthor(entry),
          content: entry.content,
          channelId: channel.id,
          channelName: channel.name,
        })),
    );
  const history: {
    source: string;
    messages: import("../../types.ts").BackgroundMessage[];
    note?: string;
    limited?: boolean;
  } = { source: "discord", messages: formatEntries(entries, message.channel) };
  if (message.channel.isThread()) {
    try {
      const parent =
        message.channel.parent ?? (await client.channels.fetch(message.channel.parentId));
      if (!parent || !("messages" in parent))
        throw new Error("Parent channel history is unavailable");
      const parentEntries = await parent.messages.fetch({ limit, before: message.id });
      const parentMessages = formatEntries(parentEntries, parent);
      // Reserve space for both sources before the tool applies its total limit.
      const parentCount = Math.min(
        parentMessages.length,
        Math.max(Math.ceil(limit / 2), limit - history.messages.length),
      );
      const threadCount = limit - parentCount;
      history.messages = [
        ...(parentCount > 0 ? parentMessages.slice(-parentCount) : []),
        ...(threadCount > 0 ? history.messages.slice(-threadCount) : []),
      ];
      history.note =
        "История родительского канала и ветки до текущего запроса, в пределах общего лимита. Источники обозначены channelId и channelName.";
    } catch {
      history.limited = true;
      history.note = "Доступна только история ветки: не удалось прочитать родительский канал.";
    }
  }
  return history;
}
