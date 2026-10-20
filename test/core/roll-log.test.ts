/** @file Dice journal results match delivered replies, including advantage and failed delivery. */
import { expect, test } from "bun:test";
import type { Message } from "discord.js";
import { createRequestLog } from "../../src/core/request-log.ts";
import { discordRecorder, telegramRecorder } from "../../src/adapters/shared/request-context.ts";
import { handleDiscordRoll, handleTelegramRoll } from "../../src/adapters/shared/dice.ts";
import { fixture } from "../support/fixtures.ts";
import { temporaryDirectory } from "../support/temp.ts";

test.each(["!roll 2d6+5", "!r d20+3 adv", "!r d20 dis", "!roll invalid"])(
  "journal preserves exact Discord and Telegram dice reply: %s",
  async (text) => {
    const directory = await temporaryDirectory("roll-log-");
    const filename = `${directory}/requests.jsonl`;
    const journal = createRequestLog(filename);
    const discordReplies: string[] = [];
    const telegramReplies: string[] = [];
    const discord = fixture<Message>({
      id: "discord-request",
      content: text,
      author: { id: "alice", username: "alice" },
      guildId: "guild",
      guild: { name: "Guild" },
      channelId: "channel",
      reply: async ({ content }: { content: string }) => {
        discordReplies.push(content);
      },
    });
    const telegram = fixture<import("@grammyjs/types").Message>({
      message_id: 1,
      text,
      from: { id: 2, first_name: "Alice" },
      chat: { id: 3, type: "supergroup", title: "Group" },
    });
    await handleDiscordRoll(discord, discordRecorder(discord, journal.record));
    await handleTelegramRoll(
      telegram,
      "testbot",
      fixture<import("../../src/types.ts").TelegramApi>(
        async (_method: string, payload: { text: string }) => {
          telegramReplies.push(payload.text);
        },
      ),
      telegramRecorder(telegram, journal.record),
    );
    await journal.close();
    const entries = (await Bun.file(filename).text())
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(entries).toHaveLength(2);
    expect(entries[0].result).toBe(discordReplies.join(""));
    expect(entries[1].result).toBe(telegramReplies.join(""));
    expect(entries.map((entry) => entry.text)).toEqual([text, text]);
    expect(entries.map((entry) => entry.feature)).toEqual(["roll", "roll"]);
    if (text.endsWith("invalid")) expect(entries[0].result).toContain("Используйте !roll");
    else expect(entries[0].result).toContain(" = ");
  },
);

test("roll is journaled once even if delivery fails", async () => {
  const directory = await temporaryDirectory("roll-log-failed-delivery-");
  const filename = `${directory}/requests.jsonl`;
  const journal = createRequestLog(filename);
  let attempted: string;
  const message = fixture<Message>({
    id: "request",
    content: "!r d6",
    author: { id: "alice", username: "alice" },
    reply: async ({ content }: { content: string }) => {
      attempted = content;
      throw new Error("Delivery failed");
    },
  });
  await expect(
    handleDiscordRoll(message, discordRecorder(message, journal.record)),
  ).rejects.toThrow("Delivery failed");
  await journal.close();
  const entries = (await Bun.file(filename).text())
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  expect(entries).toHaveLength(1);
  expect(entries[0].result).toBe(attempted);
});
