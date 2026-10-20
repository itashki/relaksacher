/** @file Verify burst timing, author/topic/reply isolation, alias lookup and cancellation. */
import { expect, test } from "bun:test";
import { createMessageBatches } from "../../src/core/message-batches.ts";

type Entry = {
  id: string;
  room: string;
  author: string;
  text: string;
  reply?: string;
  boundary?: boolean;
  immediate?: boolean;
};
const entry = (id: string, text: string, extra: Partial<Entry> = {}): Entry => ({
  id,
  text,
  room: "room",
  author: "alice",
  ...extra,
});
function setup() {
  const received: Entry[] = [];
  const batches = createMessageBatches<Entry>({
    windowMs: 15,
    describe: (message) => message,
    merge: (messages) => ({ ...messages[0], text: messages.map((m) => m.text).join("\n") }),
    deliver: async (message) => {
      received.push(message);
    },
  });
  return { batches, received };
}

test("consecutive fragments form one request and every member resolves to the full burst", async () => {
  const { batches, received } = setup();
  try {
    const first = batches.push(entry("1", "first", { reply: "parent" }));
    const second = batches.push(entry("2", "second"));
    await Promise.all([first, second]);
    expect(received.map((m) => m.text)).toEqual(["first\nsecond"]);
    expect(batches.resolve(entry("2", "second")).text).toBe("first\nsecond");
    expect(batches.resolve(entry("2", "elsewhere", { room: "other" })).text).toBe("elsewhere");
    await batches.push(entry("3", "later"));
    expect(received.map((m) => m.text)).toEqual(["first\nsecond", "later"]);
  } finally {
    batches.stop();
  }
});

test("sender changes, commands and changed reply targets separate runs while topics stay independent", async () => {
  const { batches, received } = setup();
  try {
    await Promise.all([
      batches.push(entry("1", "alice", { reply: "a" })),
      batches.push(entry("2", "bob", { author: "bob" })),
      batches.push(entry("3", "command", { boundary: true })),
      batches.push(entry("4", "new reply", { reply: "b" })),
      batches.push(entry("5", "other topic", { room: "topic" })),
    ]);
    expect(received.map((m) => m.text)).toEqual([
      "alice",
      "bob",
      "command",
      "new reply",
      "other topic",
    ]);
  } finally {
    batches.stop();
  }
});

test("shutdown resolves pending callers without delivering requests", async () => {
  const { batches, received } = setup();
  const pending = batches.push(entry("1", "pending"));
  batches.stop();
  await pending;
  await batches.push(entry("2", "after stop"));
  await Bun.sleep(25);
  expect(received).toEqual([]);
});

test("a control command can discard pending speech without delivering it", async () => {
  const { batches, received } = setup();
  const waiting = batches.push(entry("1", "!tts pending"));
  batches.cancel("room", (message) => message.text.startsWith("!tts"));
  await waiting;
  await batches.push(entry("2", "stop", { immediate: true }));
  expect(received.map((m) => m.text)).toEqual(["stop"]);
  batches.stop();
});
