/** @file Durable request journaling, metadata attribution and exclusion of generated content. */
import { expect, test } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { createRequestLog, type RequestContext } from "../../src/core/request-log.ts";
import { discordRecorder, telegramRecorder } from "../../src/adapters/shared/request-context.ts";
import { temporaryDirectory } from "../support/temp.ts";
import { createDiscordBot, createTelegramBot, fixture } from "../support/fixtures.ts";
import type { Message, Interaction, ClientUser } from "discord.js";

const context: RequestContext = {
  platform: "discord",
  requestId: "request",
  user: { id: "user", name: "Alice", username: "alice" },
  server: { id: "guild", name: "Guild" },
  channel: { id: "room", name: "general" },
  text: "question\nwith another line",
};

test("journal creates directories, serializes concurrent records and appends after reopening", async () => {
  const directory = await temporaryDirectory("request-log-");
  const filename = `${directory}/nested/requests.jsonl`;
  const journal = createRequestLog(filename, { now: () => new Date("2026-10-20T12:34:56Z") });
  for (let index = 0; index < 30; index++)
    journal.record("model", { ...context, requestId: String(index) });
  await journal.close();
  journal.record("roll", context);
  const reopened = createRequestLog(filename);
  reopened.record("roll", context);
  await reopened.close();
  const lines = (await Bun.file(filename).text()).trimEnd().split("\n");
  expect(lines).toHaveLength(31);
  const entries = lines.map((line) => JSON.parse(line));
  expect(entries.slice(0, 30).map((entry) => entry.requestId)).toEqual(
    Array.from({ length: 30 }, (_, index) => String(index)),
  );
  expect(entries[0]).toEqual({
    ...context,
    requestId: "0",
    timestamp: "2026-10-20T12:34:56.000Z",
    feature: "model",
  });
  expect(entries[30].feature).toBe("roll");
});

test("journal strips transcripts and unexpected response/history fields", async () => {
  const directory = await temporaryDirectory("request-log-exclusions-");
  const filename = `${directory}/requests.jsonl`;
  const journal = createRequestLog(filename);
  const extra = {
    ...context,
    text: "voice transcript must not be saved",
    response: "model answer",
    history: ["old answer"],
    thinking: "thoughts",
  };
  journal.record("transcribe", extra);
  journal.record("model", { ...extra, text: "user input" });
  await journal.flush();
  const text = await Bun.file(filename).text();
  for (const excluded of ["voice transcript", "model answer", "old answer", "thoughts"])
    expect(text).not.toContain(excluded);
  const entries = text
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  expect(entries[0].text).toBeUndefined();
  expect(entries[0].user.name).toBe("Alice");
  expect(entries[1].text).toBe("user input");
});

test("failed writes are reported, do not reject flush and allow later recovery", async () => {
  const directory = await temporaryDirectory("request-log-recovery-");
  const filename = `${directory}/requests.jsonl`;
  await mkdir(filename);
  const errors: unknown[] = [];
  const journal = createRequestLog(filename, {
    report: (error) => {
      errors.push(error);
    },
  });
  journal.record("roll", context);
  await journal.flush();
  expect(errors).toHaveLength(1);
  await rm(filename, { recursive: true });
  journal.record("model", context);
  await journal.close();
  expect(JSON.parse((await Bun.file(filename).text()).trim()).feature).toBe("model");
});

test("Discord context reads author, guild and channel but never reply text or component message", () => {
  const records: RequestContext[] = [];
  const record = (_feature: string, request: RequestContext) => {
    records.push(request);
  };
  const source = fixture<Message>({
    id: "request",
    content: "question",
    author: { id: "1", username: "alice" },
    member: { displayName: "Alice" },
    guildId: "2",
    guild: { id: "2", name: "Guild" },
    channelId: "3",
    channel: { id: "3", name: "chat" },
    fetchReference() {
      throw new Error("must not read replies");
    },
  });
  discordRecorder(source, record)("model");
  source.content = "transcription";
  discordRecorder(source, record)("transcribe");
  discordRecorder(
    fixture<Interaction>({
      id: "interaction",
      user: { id: "1", username: "alice" },
      guildId: "2",
      guild: { name: "Guild" },
      channelId: "3",
      customId: "music:pause",
      message: { content: "long model answer" },
      isModalSubmit: () => false,
    }),
    record,
  )("music");
  expect(records[0]).toEqual({
    platform: "discord",
    requestId: "request",
    user: { id: "1", name: "Alice", username: "alice" },
    server: { id: "2", name: "Guild" },
    channel: { id: "3", name: "chat" },
    text: "question",
  });
  expect(records[1].text).toBeUndefined();
  expect(records[2].text).toBe('{"customId":"music:pause"}');
  expect(JSON.stringify(records)).not.toContain("long model answer");
});

test("Telegram context freezes incoming text, includes topic and excludes replies and transcripts", () => {
  const records: RequestContext[] = [];
  const source = fixture<import("@grammyjs/types").Message>({
    message_id: 5,
    text: "question",
    message_thread_id: 6,
    from: { id: 1, first_name: "Alice", last_name: "Smith", username: "alice" },
    chat: { id: -2, type: "supergroup", title: "Group" },
    reply_to_message: { text: "long answer or voice transcript" },
  });
  const record = telegramRecorder(source, (_feature, request) => {
    records.push(request);
  });
  source.text = "rewritten text";
  record("model");
  record("transcribe");
  expect(records[0]).toEqual({
    platform: "telegram",
    requestId: "5",
    user: { id: "1", name: "Alice Smith", username: "alice" },
    server: { id: "-2", name: "Group" },
    channel: { id: "-2", threadId: "6" },
    text: "question",
  });
  expect(records[1].text).toBeUndefined();
  expect(JSON.stringify(records)).not.toContain("voice transcript");
});

test("Discord and Telegram route real requests to the journal without generated responses", async () => {
  const directory = await temporaryDirectory("request-log-adapters-");
  const filename = `${directory}/requests.jsonl`;
  const journal = createRequestLog(filename);
  const assistant = {
    createSession: () => ({
      stop() {},
      async run() {
        return { text: "long answer must not be saved" };
      },
    }),
  };
  const discord = createDiscordBot({ config: {}, assistant, onRequest: journal.record });
  discord.client.user = fixture<ClientUser>({ id: "bot" });
  const telegram = createTelegramBot({
    config: {},
    assistant,
    onRequest: journal.record,
    api: async (method) =>
      method === "getMe" ? { id: 99, username: "testbot" } : { message_id: 20 },
    transcribe: async () => "voice transcript must not be saved",
  });
  try {
    await discord.receiveMessage(
      fixture<Message>({
        id: "1",
        content: "!r d6",
        author: { id: "1", username: "alice" },
        guildId: "2",
        guild: { name: "Guild" },
        channelId: "3",
        reply: async () => ({}),
      }),
    );
    await telegram.handleUpdate({
      update_id: 1,
      message: {
        message_id: 1,
        text: "hello",
        from: { id: 1, first_name: "Alice" },
        chat: { id: 1, type: "private" },
      },
    });
    await telegram.handleUpdate({
      update_id: 2,
      message: {
        message_id: 2,
        text: "!transcribe",
        from: { id: 1, first_name: "Alice" },
        chat: { id: 1, type: "private" },
        reply_to_message: {
          voice: { file_id: "voice" },
          chat: { id: 1, type: "private" },
          from: { id: 1, first_name: "Alice" },
          message_id: 3,
        },
      },
    });
    await journal.flush();
    const text = await Bun.file(filename).text();
    const entries = text
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(entries.map((entry) => entry.feature)).toEqual(["roll", "model", "transcribe"]);
    expect(entries[0].server.name).toBe("Guild");
    expect(entries[1].server.name).toBe("Личные сообщения");
    expect(entries[1].user.name).toBe("Alice");
    expect(text).not.toContain("must not be saved");
  } finally {
    await discord.stop();
    await telegram.stop();
    await journal.close();
  }
});
