/** @file Attributed model-tool journal events without output leaks or repeated request counts. */
import { expect, test } from "bun:test";
import { createRequestLog } from "../../src/core/request-log.ts";
import {
  discordRecorder,
  telegramRecorder,
  toolRecorder,
} from "../../src/adapters/shared/request-context.ts";
import { createStatistics, type RecordRequest } from "../../src/core/statistics.ts";
import { setup } from "../support/assistant-fixture.ts";
import { temporaryDirectory } from "../support/temp.ts";
import { fixture, createDiscordBot, createTelegramBot } from "../support/fixtures.ts";
import type { ClientUser, Message } from "discord.js";

const search = { function: { name: "web_search", arguments: { query: "Bun runtime" } } };
const thinking = { function: { name: "enable_thinking", arguments: {} } };

test("executed tool calls are logged in order with parent attribution and no tool results", async () => {
  const directory = await temporaryDirectory("tool-log-");
  const filename = `${directory}/requests.jsonl`;
  const journal = createRequestLog(filename);
  const statistics = createStatistics();
  const record: RecordRequest = (feature, context, details) => {
    if (details?.kind !== "tool") statistics.record(feature);
    journal.record(feature, context, details);
  };
  const bound = discordRecorder(
    fixture<Message>({
      id: "request",
      content: "look it up",
      author: { id: "alice", username: "alice" },
      guildId: "guild",
      guild: { name: "Guild" },
      channelId: "channel",
    }),
    record,
  );
  const env = setup(
    [
      [{ message: { tool_calls: [thinking, search] } }],
      [{ message: { content: "long model answer" } }],
    ],
    { toolService: { definitions: () => [], runTool: async () => "long tool result" } },
  );
  bound("model");
  await env.assistant.createSession({ ...env.options, onToolCall: toolRecorder(bound) }).run();
  await journal.close();
  const text = await Bun.file(filename).text();
  const entries = text
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  expect(entries).toHaveLength(3);
  expect(entries.slice(1).map((entry) => entry.tool.name)).toEqual([
    "enable_thinking",
    "web_search",
  ]);
  expect(entries[2].event).toBe("tool_call");
  expect(entries[2].tool.arguments).toEqual({ query: "Bun runtime" });
  expect(entries[2].requestId).toBe("request");
  expect(entries[2].user.username).toBe("alice");
  expect(entries[2].server.name).toBe("Guild");
  expect(entries[2].text).toBeUndefined();
  expect(text).not.toContain("long model answer");
  expect(text).not.toContain("long tool result");
  expect(statistics.snapshot().total).toBe(1);
});

test("hook records failed tool attempts once and ignores streamed status repetitions", async () => {
  const calls: string[] = [];
  const env = setup([[{ message: { tool_calls: [search] } }]], {
    toolService: {
      definitions: () => [],
      runTool: async () => {
        throw new Error("tool failed");
      },
    },
  });
  await env.assistant
    .createSession({
      ...env.options,
      onToolCall: (call) => {
        calls.push(call.function.name);
      },
    })
    .run();
  expect(calls).toEqual(["web_search"]);
});

test("Telegram-bound calls keep user and topic attribution", () => {
  let captured: unknown;
  const bound = telegramRecorder(
    fixture<import("@grammyjs/types").Message>({
      message_id: 7,
      text: "question",
      message_thread_id: 9,
      from: { id: 1, first_name: "Alice" },
      chat: { id: -2, type: "supergroup", title: "Group" },
    }),
    (_feature, context, details) => {
      captured = { context, details };
    },
  );
  toolRecorder(bound)(search);
  expect(captured).toMatchObject({
    context: { user: { name: "Alice" }, server: { name: "Group" }, channel: { threadId: "9" } },
    details: { kind: "tool", call: search },
  });
});

test("both messenger adapters pass attributed tool hooks to sessions", async () => {
  const events: { platform: string; name: string }[] = [];
  const record: RecordRequest = (_feature, context, details) => {
    if (details?.kind === "tool")
      events.push({ platform: context.platform, name: details.call.function.name });
  };
  const assistant = {
    createSession(options: import("../../src/types.ts").SessionOptions) {
      return {
        stop() {},
        async run() {
          options.onToolCall(search);
          return { text: "answer" };
        },
      };
    },
  };
  const discord = createDiscordBot({ config: {}, assistant, onRequest: record });
  discord.client.user = fixture<ClientUser>({ id: "bot" });
  const telegram = createTelegramBot({
    config: {},
    assistant,
    onRequest: record,
    api: async (method) =>
      method === "getMe" ? { id: 99, username: "testbot" } : { message_id: 10 },
  });
  try {
    await discord.receiveMessage(
      fixture<Message>({
        id: "request",
        content: "question",
        author: { id: "alice", username: "alice" },
        mentions: { has: () => true },
        channel: { isThread: () => false },
        reply: async () => ({}),
      }),
    );
    await telegram.handleUpdate({
      update_id: 1,
      message: {
        message_id: 1,
        text: "question",
        from: { id: 1, first_name: "Alice" },
        chat: { id: 1, type: "private" },
      },
    });
    expect(events).toEqual([
      { platform: "discord", name: "web_search" },
      { platform: "telegram", name: "web_search" },
    ]);
  } finally {
    await discord.stop();
    await telegram.stop();
  }
});
