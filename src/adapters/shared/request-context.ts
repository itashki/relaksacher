/** @file Bind incoming messenger identity and location to request telemetry without reading replies. */
import type { Message, Interaction } from "discord.js";
import type { RequestContext } from "../../core/request-log.ts";
import type { RecordRequest } from "../../core/statistics.ts";

/** Bind Discord metadata lazily, excluding component message content and all reply ancestors. */
export function discordRecorder(
  event: Message | Interaction,
  record?: RecordRequest,
): RecordRequest {
  return (feature, _context, details) => {
    if (!record) return;
    const message = "author" in event ? event : null;
    const user = message?.author ?? (event as Interaction).user;
    const context: RequestContext = {
      platform: "discord",
      requestId: event.id,
      user: {
        id: user.id,
        name: message?.member?.displayName ?? user.globalName ?? user.username,
        username: user.username,
      },
      server: {
        id: event.guildId ?? event.guild?.id ?? null,
        name: event.guild?.name ?? (event.guildId ? event.guildId : "Личные сообщения"),
      },
      channel: {
        id: event.channelId ?? event.channel?.id ?? "dm",
        name: event.channel && "name" in event.channel ? event.channel.name : undefined,
      },
    };
    if (feature !== "transcribe") {
      if (message) context.text = message.content ?? "";
      else if ("customId" in event) {
        const values = "values" in event ? event.values : undefined;
        const fields = event.isModalSubmit?.()
          ? [...event.fields.fields.values()].map((field) => ({
              id: field.customId,
              value: "value" in field ? field.value : undefined,
            }))
          : undefined;
        context.text = JSON.stringify({ customId: event.customId, values, fields });
      }
    }
    record(feature, context, details);
  };
}

/** Capture Telegram's raw incoming request before history normalization; never copy replied messages. */
export function telegramRecorder(
  message: import("@grammyjs/types").Message,
  record?: RecordRequest,
): RecordRequest {
  const user = message.from;
  const chat = message.chat;
  const text = message.text ?? message.caption ?? "";
  return (feature, _context, details) => {
    if (!record || !user) return;
    record(
      feature,
      {
        platform: "telegram",
        requestId: String(message.message_id),
        user: {
          id: String(user.id),
          name: [user.first_name, user.last_name].filter(Boolean).join(" "),
          username: user.username,
        },
        server: { id: String(chat.id), name: "title" in chat ? chat.title : "Личные сообщения" },
        channel: {
          id: String(chat.id),
          threadId: message.message_thread_id ? String(message.message_thread_id) : undefined,
        },
        ...(feature === "transcribe" ? {} : { text }),
      },
      details,
    );
  };
}

/** Attribute each executed model tool to its parent request without counting another request. */
export function toolRecorder(record: RecordRequest) {
  return (call: import("../../types.ts").ToolCall) =>
    record("model", undefined, { kind: "tool", call });
}
