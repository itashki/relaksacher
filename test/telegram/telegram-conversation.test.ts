/** @file Unit coverage for Telegram reply-chain collection, conversation mapping and addressing. */
import { expect, test } from "bun:test";
import type { Message } from "@grammyjs/types";
import {
  MAX_REPLY_CHAIN,
  buildTelegramConversation,
  collectTelegramReplyChain,
  isTelegramBotAddressed,
} from "../../src/adapters/telegram/conversation.ts";

const me = { id: 1, username: "Bot", is_bot: true, first_name: "Bot" };
const user = { id: 2, is_bot: false, first_name: "Ann" };

function msg(id: number, text: string, extra: Record<string, unknown> = {}): Message {
  return {
    message_id: id,
    date: 0,
    chat: { id: 5, type: "group", title: "g" },
    from: user,
    text,
    ...extra,
  } as unknown as Message;
}

test("bounds the reply chain to the maximum length", () => {
  let parent: Message | undefined;
  for (let id = 1; id <= 100; id++) parent = msg(id, `m${id}`, { reply_to_message: parent });
  const chain = collectTelegramReplyChain(parent, [], (entry) => entry);
  expect(chain).toHaveLength(MAX_REPLY_CHAIN);
  expect(chain.at(-1)).toBe(parent);
  expect(chain[0].message_id).toBe(100 - MAX_REPLY_CHAIN + 1);
});

test("stops on reply cycles through the resolver or history", () => {
  const a = msg(10, "a");
  const b = msg(9, "b", { reply_to_message: a });
  const cyclic = msg(10, "a", { reply_to_message: b });
  const chain = collectTelegramReplyChain(cyclic, [], (entry) => entry);
  expect(chain.map((entry) => entry.message_id)).toEqual([9, 10]);
  const looped = collectTelegramReplyChain(
    msg(3, "c", { reply_to_message: msg(2, "b") }),
    [msg(2, "b", { reply_to_message: msg(3, "c") })],
    (entry) => entry,
  );
  expect(looped.map((entry) => entry.message_id)).toEqual([2, 3]);
});

test("strips a leading bot mention and bot commands", () => {
  const text = "@bot hello";
  const entities = [{ type: "mention", offset: 0, length: 4 }];
  const [entry] = buildTelegramConversation([msg(1, text, { entities })], me);
  expect(entry.role).toBe("user");
  expect(entry.content).toBe("[Автор: Ann (username: нет, id: 2)]\nhello");
  const [plain] = buildTelegramConversation([msg(2, "  @BOT  hi")], me);
  expect(plain.content.endsWith("\nhi")).toBe(true);
  const [other] = buildTelegramConversation([msg(3, "@someone hi")], me);
  expect(other.content.endsWith("\n@someone hi")).toBe(true);
});

test("maps bot messages to assistant turns and formats quotes as JSON", () => {
  const quoted = msg(4, "reply", {
    reply_to_message: msg(3, "src"),
    quote: { text: "frag", position: 2, is_manual: true },
  });
  const result = buildTelegramConversation([msg(1, "bot says", { from: me }), quoted], me);
  expect(result[0]).toEqual({ role: "assistant", content: "bot says" });
  const json = JSON.stringify({ text: "frag", messageId: 3, position: 2, manuallySelected: true });
  expect(result[1].content).toBe(
    `[Автор: Ann (username: нет, id: 2)]\nЦитируемый фрагмент (JSON): ${json}\nТекст реплики:\nreply`,
  );
});

test("recognizes mentions and /think but not other commands", () => {
  const mention = msg(1, "yo @bot", { entities: [{ type: "mention", offset: 3, length: 4 }] });
  expect(isTelegramBotAddressed(mention, me)).toBe(true);
  const think = msg(2, "/think@bot q", {
    entities: [{ type: "bot_command", offset: 0, length: 10 }],
  });
  expect(isTelegramBotAddressed(think, me)).toBe(true);
  const other = msg(3, "/roll", { entities: [{ type: "bot_command", offset: 0, length: 5 }] });
  expect(isTelegramBotAddressed(other, me)).toBe(false);
  expect(isTelegramBotAddressed(msg(4, "hi"), me)).toBe(false);
});
