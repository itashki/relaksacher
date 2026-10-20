/** @file Verify Whisper protocol, serialized work and bounded audio downloads. */
import { expect, test } from "bun:test";
import { createTranscriber } from "../../src/core/speech/transcription.ts";
import { downloadVoice } from "../../src/adapters/speech/voice.ts";
import { createTelegramBot, createDiscordBot } from "../support/fixtures.ts";
import { Events, MessageFlags } from "discord.js";

test("Whisper serializes downloads and inference and preserves the recognized text", async () => {
  const events: string[] = [];
  const transcribe = createTranscriber({
    fetchImpl: async (_, init) => {
      events.push("infer");
      const form = init.body as FormData;
      expect(form.get("language")).toBe("auto");
      expect(form.get("translate")).toBe("false");
      expect((form.get("file") as File).size).toBe(3);
      return Response.json({ text: " Привет! " });
    },
  });
  const load = async () => {
    events.push("load");
    return new Blob(["ogg"]);
  };
  expect(await Promise.all([transcribe(load), transcribe(load)])).toEqual(["Привет!", "Привет!"]);
  expect(events).toEqual(["load", "infer", "load", "infer"]);
});

test("Whisper rejects failure, empty speech and invalid responses", async () => {
  for (const response of [
    new Response("", { status: 500 }),
    Response.json({ text: " " }),
    Response.json({}),
  ]) {
    const transcribe = createTranscriber({ fetchImpl: async () => response });
    await expect(transcribe(async () => new Blob(["ogg"]))).rejects.toThrow();
  }
});

test("voice downloads reject foreign hosts and oversized streamed bodies without exposing URLs", async () => {
  await expect(downloadVoice("https://evil.example/secret", { allowedHosts: [] })).rejects.toThrow(
    "Voice download failed",
  );
  await expect(
    downloadVoice("https://api.telegram.org/secret", {
      allowedHosts: ["api.telegram.org"],
      fetchImpl: async () => new Response(new Uint8Array(20 * 1024 * 1024 + 1)),
    }),
  ).rejects.toThrow("Voice download failed");
});

test("Telegram transcribes unaddressed group voice messages, splits plain text and preserves topic/reply", async () => {
  const calls: Record<string, unknown>[] = [];
  const bot = createTelegramBot({
    config: {},
    assistant: {
      createSession() {
        throw new Error("No LLM expected");
      },
    },
    api: Object.assign(
      async (method: string, payload: Record<string, unknown>) => {
        if (method === "getMe") return { id: 99 };
        calls.push(payload);
        return {};
      },
      { downloadVoice: async () => new Blob(["ogg"]) },
    ),
    transcribe: async (load) => {
      await load();
      return "<tag>" + "я".repeat(5000);
    },
  });
  await bot.handleUpdate({
    message: {
      message_id: 7,
      chat: { id: -1, type: "supergroup" },
      message_thread_id: 4,
      from: { id: 1 },
      voice: { file_id: "voice" },
    },
  });
  expect(calls).toHaveLength(2);
  expect(calls[0].text).toContain("<tag>");
  expect(calls.every((call) => call.message_thread_id === 4 && !call.parse_mode)).toBe(true);
  expect(calls[0].reply_parameters).toEqual({ message_id: 7, allow_sending_without_reply: true });
});

test("Discord transcribes voice messages without mention and disables mentions in output", async () => {
  const replies: Record<string, unknown>[] = [];
  const bot = createDiscordBot({
    config: {},
    assistant: {},
    memoryDirectory: "/tmp",
    transcribe: async () => "@everyone привет",
  });
  Object.defineProperty(bot.client, "user", { value: { id: "bot" }, configurable: true });
  await bot.client.listeners(Events.MessageCreate)[0]({
    id: "voice",
    channel: { id: "room" },
    author: { bot: false, id: "alice", username: "Alice" },
    flags: { has: (flag: number) => flag === MessageFlags.IsVoiceMessage },
    attachments: { first: () => ({ url: "https://cdn.discordapp.com/voice.ogg" }) },
    reply: async (payload: Record<string, unknown>) => {
      replies.push(payload);
    },
  });
  expect(replies).toHaveLength(1);
  expect(replies[0].content).toContain("@everyone привет");
  expect(replies[0].allowedMentions).toEqual({ parse: [], repliedUser: false });
});

test("Telegram history replaces a voice with raw text attributed to its speaker", async () => {
  let history: import("../../src/types.ts").BackgroundMessage[];
  const bot = createTelegramBot({
    config: {},
    api: Object.assign(
      async (method: string) => (method === "getMe" ? { id: 99, username: "testbot" } : {}),
      { downloadVoice: async () => new Blob(["ogg"]) },
    ),
    transcribe: async () => "Мои слова",
    assistant: {
      createSession(options) {
        return {
          stop() {},
          async run() {
            history = (await options.context.readHistory(10)).messages;
            return { text: "" };
          },
        };
      },
    },
  });
  await bot.handleUpdate({
    message: {
      message_id: 1,
      chat: { id: 10, type: "private" },
      from: { id: 7, first_name: "Alice" },
      voice: { file_id: "file" },
    },
  });
  await bot.handleUpdate({
    message: {
      message_id: 2,
      chat: { id: 10, type: "private" },
      from: { id: 7, first_name: "Alice" },
      text: "История",
    },
  });
  expect(history).toEqual([
    { id: "1", author: "Alice (username: нет, id: 7)", content: "Мои слова" },
  ]);
});

test("Telegram manually transcribes a replied voice and ignores another bot's command", async () => {
  const calls: Record<string, unknown>[] = [];
  const downloads: string[] = [];
  const bot = createTelegramBot({
    config: {},
    assistant: {},
    api: Object.assign(
      async (method: string, payload: Record<string, unknown>) => {
        if (method === "getMe") return { id: 99, username: "testbot" };
        calls.push(payload);
        return {};
      },
      {
        downloadVoice: async (id: string) => {
          downloads.push(id);
          return new Blob(["ogg"]);
        },
      },
    ),
    transcribe: async (load) => {
      await load();
      return "Manual transcript";
    },
  });
  for (const text of ["!расшифруй@otherbot", "!расшифруй@testbot", "!transcribe"]) {
    await bot.handleUpdate({
      message: {
        message_id: 8,
        chat: { id: -1, type: "supergroup" },
        message_thread_id: 4,
        from: { id: 1 },
        text,
        ...(text === "!transcribe"
          ? {}
          : {
              reply_to_message: {
                message_id: 7,
                chat: { id: -1, type: "supergroup" },
                from: { id: 2 },
                voice: { file_id: "old-voice" },
              },
            }),
      },
    });
  }
  expect(downloads).toEqual(["old-voice"]);
  expect(calls).toHaveLength(2);
  expect(calls[0].text).toBe("🎙\nManual transcript");
  expect(calls[0].message_thread_id).toBe(4);
  expect(calls[1].text).toContain("!transcribe");
});

test("Discord manual transcription handles retries, missing replies and unavailable service", async () => {
  for (const scenario of ["success", "failure", "missing", "unavailable"]) {
    const replies: Record<string, unknown>[] = [];
    const bot = createDiscordBot({
      config: {},
      assistant: {},
      memoryDirectory: "/tmp",
      ...(scenario === "unavailable"
        ? {}
        : {
            transcribe: async () => {
              if (scenario === "failure") throw new Error("offline");
              return "Manual transcript";
            },
          }),
    });
    Object.defineProperty(bot.client, "user", { value: { id: "bot" }, configurable: true });
    await bot.client.listeners(Events.MessageCreate)[0]({
      id: "command",
      content: "!РАСШИФРУЙ",
      channel: { id: "room" },
      author: { bot: false },
      reference: scenario === "missing" ? undefined : {},
      fetchReference: async () => ({
        id: "old-voice",
        channel: { id: "room" },
        author: { username: "Alice", id: "alice" },
        flags: { has: () => true },
        attachments: { first: () => ({ url: "https://cdn.discordapp.com/voice.ogg" }) },
      }),
      reply: async (payload: Record<string, unknown>) => {
        replies.push(payload);
      },
    });
    expect(replies).toHaveLength(1);
    expect(replies[0].content).toContain(
      {
        success: "Manual transcript",
        failure: "Не удалось",
        missing: "!transcribe",
        unavailable: "недоступна",
      }[scenario],
    );
    expect(replies[0].allowedMentions).toEqual({ parse: [], repliedUser: false });
  }
});
