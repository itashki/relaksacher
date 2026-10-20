/** @file Deterministic dice arithmetic, validation and transport command coverage. */
import { expect, test, onTestFinished } from "bun:test";
import { rollDice, parseRollCommand } from "../src/core/dice.ts";
import { setup, message } from "./support/telegram-fixture.ts";
import { createDiscordBot, fixture } from "./support/fixtures.ts";
import type { ClientUser, Message } from "discord.js";

function draws(...values: number[]) {
  return () => {
    const value = values.shift();
    if (value === undefined) throw new Error("Unexpected draw");
    return value;
  };
}

test("dice show individual results, signed groups and modifiers", () => {
  expect(rollDice("2d6+5-d4", draws(2, 6, 3))).toBe("[2 + 6] + 5 − [3] = 10");
});

test.each(["adv", "преимущество"])("advantage selects each maximum: %s", (mode) => {
  const result = rollDice(`2d20 + 3 ${mode}`, draws(4, 18, 15, 2));
  expect(result).toBe("[(4, 18 → 18) + (15, 2 → 15)] + 3 = 36");
});

test.each(["dis", "помеха"])("disadvantage selects each minimum: %s", (mode) => {
  expect(rollDice(`d20-2 ${mode}`, draws(19, 5))).toBe("[(19, 5 → 5)] − 2 = 3");
});

test.each([
  "",
  "5",
  "0d6",
  "d1",
  "101d6",
  "d1000001",
  "d6+1000001",
  "d6+d0",
  "d6/2",
  "d6 junk",
  "d6 adv dis",
  "2 0d6",
  "d6++5",
  "d6+",
  "d6".repeat(100),
])("invalid expression draws nothing: %s", (expression) => {
  let calls = 0;
  expect(
    rollDice(expression, () => {
      calls++;
      return 1;
    }),
  ).toContain("Используйте !roll");
  expect(calls).toBe(0);
});

test("command boundaries, aliases and usernames", () => {
  expect(parseRollCommand(" !R d20 ")).toEqual({ username: undefined, argument: "d20" });
  expect(parseRollCommand("!roll@testbot 2d6")).toEqual({ username: "testbot", argument: "2d6" });
  expect(parseRollCommand("!restart")).toBeNull();
  expect(parseRollCommand("!roller d6")).toBeNull();
});

test("Telegram group roll preserves topic and reply without invoking model", async () => {
  const { bot, calls, inputs } = setup();
  onTestFinished(() => bot.stop());
  await bot.handleUpdate({
    update_id: 1,
    message: {
      ...message(7, "!r@testbot d6", { id: 1, type: "supergroup" }),
      message_thread_id: 42,
    },
  });
  const sent = calls.find((call) => call.method === "sendMessage").payload;
  expect(sent.text).toMatch(/^\[[1-6]\] = [1-6]$/u);
  expect(sent.message_thread_id).toBe(42);
  expect(sent.reply_parameters.message_id).toBe(7);
  expect(inputs).toHaveLength(0);
  await bot.handleUpdate({ update_id: 2, message: message(8, "!roll@other d6") });
  expect(calls.filter((call) => call.method === "sendMessage")).toHaveLength(1);
});

test("Discord roll needs no mention or model and suppresses reply pings", async () => {
  const bot = createDiscordBot({
    config: {},
    assistant: {
      createSession() {
        throw new Error("must not generate");
      },
    },
  });
  onTestFinished(() => bot.stop());
  bot.client.user = fixture<ClientUser>({ id: "bot" });
  const replies: { content: string; allowedMentions: unknown }[] = [];
  await bot.receiveMessage(
    fixture<Message>({
      author: { id: "user", bot: false },
      content: "!roll d6",
      reply: async (payload: (typeof replies)[number]) => {
        replies.push(payload);
      },
    }),
  );
  expect(replies[0].content).toMatch(/^\[[1-6]\] = [1-6]$/u);
  expect(replies[0].allowedMentions).toEqual({ parse: [], repliedUser: false });
});
