/** @file Process telemetry arithmetic, isolated snapshots and messenger routing coverage. */
import { expect, test, onTestFinished } from "bun:test";
import { createStatistics } from "../../src/core/statistics.ts";
import {
  recordDiscordRequest,
  recordTelegramRequest,
  recordDiscordInteraction,
} from "../../src/adapters/shared/request-statistics.ts";
import { createDiscordBot, createTelegramBot, fixture } from "../support/fixtures.ts";
import type { ClientUser, Message } from "discord.js";

test("statistics track monotonic uptime, total and independent feature counts", () => {
  let elapsed = 0;
  const statistics = createStatistics(() => elapsed);
  statistics.record("model");
  statistics.record("roll");
  statistics.record("roll");
  const first = statistics.snapshot();
  first.counts.roll = 99;
  elapsed = 90061000;
  expect(statistics.snapshot()).toEqual({
    uptimeMs: elapsed,
    total: 3,
    counts: { model: 1, roll: 2, music: 0, voice: 0, tts: 0, transcribe: 0, access: 0 },
  });
});

test("command routing excludes chatter, foreign Telegram commands and stop controls", () => {
  const statistics = createStatistics();
  for (const command of [
    "!voice hi",
    "!ГОЛОС",
    "!music help",
    "!музыка",
    "!tts stop",
    "!озвучь",
    "!access",
    "!доступ",
    "!transcribe",
    "!расшифруй",
  ])
    recordDiscordRequest(command, false, statistics.record);
  recordDiscordRequest("!transcribe", true, statistics.record);
  recordDiscordRequest("", true, statistics.record);
  recordDiscordRequest("hello", false, statistics.record);
  recordDiscordRequest("!musical", false, statistics.record);
  recordTelegramRequest("!VOICE@TestBot hi", false, "testbot", statistics.record);
  recordTelegramRequest("!transcribe@testbot", false, "testbot", statistics.record);
  recordTelegramRequest("!voice@other hi", false, "testbot", statistics.record);
  recordTelegramRequest("!music", false, "testbot", statistics.record);
  recordTelegramRequest("", true, "testbot", statistics.record);
  recordDiscordInteraction("music:pause:1", statistics.record);
  recordDiscordInteraction("access:menu:token:save", statistics.record);
  recordDiscordInteraction("stop_generation:1", statistics.record);
  expect(statistics.snapshot().counts).toEqual({
    model: 0,
    roll: 0,
    music: 3,
    voice: 3,
    tts: 2,
    transcribe: 6,
    access: 3,
  });
  expect(statistics.snapshot().total).toBe(17);
});

test("Telegram counts roll errors and model sessions once across streamed updates", async () => {
  const statistics = createStatistics();
  const bot = createTelegramBot({
    config: {},
    onRequest: statistics.record,
    api: async (method) =>
      method === "getMe" ? { id: 99, username: "testbot" } : { message_id: 20 },
    assistant: {
      createSession(options) {
        return {
          stop() {},
          async run() {
            await options.onUpdate({ text: "a", final: false });
            await options.onUpdate({ text: "answer", final: true });
            return { text: "answer" };
          },
        };
      },
    },
  });
  onTestFinished(() => bot.stop());
  let id = 0;
  for (const text of ["!roll d6", "!r invalid", "!r@other d6", "!voice", "!transcribe", "hello"])
    await bot.handleUpdate({
      update_id: ++id,
      message: {
        message_id: id,
        text,
        from: { id: 1, first_name: "User" },
        chat: { id: 1, type: "private" },
      },
    });
  expect(statistics.snapshot().counts).toEqual({
    model: 1,
    roll: 2,
    music: 0,
    voice: 1,
    tts: 0,
    transcribe: 1,
    access: 0,
  });
  expect(statistics.snapshot().total).toBe(5);
});

test("Discord counts immediate dice, failed commands and accepted model sessions", async () => {
  const statistics = createStatistics();
  const bot = createDiscordBot({
    config: {},
    onRequest: statistics.record,
    assistant: {
      createSession() {
        return { stop() {}, async run() {} };
      },
    },
  });
  bot.client.user = fixture<ClientUser>({ id: "bot" });
  onTestFinished(() => bot.stop());
  for (const content of ["!r d6", "!voice", "!transcribe", "hello"])
    await bot.receiveMessage(
      fixture<Message>({
        id: content,
        content,
        author: { id: "user", username: "User", bot: false },
        mentions: { has: () => true },
        channel: { isThread: () => false },
        reply: async () => ({}),
      }),
    );
  expect(statistics.snapshot().counts).toEqual({
    model: 1,
    roll: 1,
    music: 0,
    voice: 1,
    tts: 0,
    transcribe: 1,
    access: 0,
  });
});
