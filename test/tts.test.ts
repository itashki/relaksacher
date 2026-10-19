/** @file Verify TTS command routing, reply text, limits, serialization and cancellation. */
import { expect, test } from "bun:test";
import { ChannelType, type Message } from "discord.js";
import { createDiscordTts } from "../src/adapters/discord-tts.ts";
import { fixture } from "./fixtures.ts";

/** Minimal message with a controllable voice channel and captured replies. */
function message(content: string, voice = true) {
  const replies: string[] = [];
  const request = fixture<Message>({
    content,
    author: { id: "user" },
    guild: {
      id: "tts-test",
      members: {
        fetch: async () => ({
          voice: { channel: voice ? { id: "voice", type: ChannelType.GuildVoice } : null },
        }),
      },
    },
    reference: content === "!tts" ? { messageId: "original" } : undefined,
    fetchReference: async () => ({ content: "Текст исходного сообщения" }),
    reply: async (payload) => {
      replies.push(
        typeof payload === "string" ? payload : "content" in payload ? payload.content : "",
      );
      return {};
    },
  });
  return { request, replies };
}

test("TTS reads explicit text and replied messages without invoking models", async () => {
  const texts: string[] = [];
  const tts = createDiscordTts({
    execute: async (_, text) => {
      texts.push(text);
    },
  });
  const first = message("!tts Привет!");
  expect(await tts.handle(first.request)).toBe(true);
  await tts.handle(message("!tts").request);
  expect(texts).toEqual(["Привет!", "Текст исходного сообщения"]);
  expect(await tts.handle(message("hello").request)).toBe(false);
  await tts.stop();
});

test("TTS validates channel access and text limits before synthesis", async () => {
  let calls = 0;
  const tts = createDiscordTts({
    execute: async () => {
      calls++;
    },
  });
  const absent = message("!tts привет", false);
  await tts.handle(absent.request);
  expect(absent.replies[0]).toContain("голосовой канал");
  const long = message("!tts " + "я".repeat(2001));
  await tts.handle(long.request);
  expect(long.replies[0]).toContain("2000");
  expect(calls).toBe(0);
  await tts.stop();
});

test("stop cancels active and queued speech and allows subsequent requests", async () => {
  const texts: string[] = [];
  let started: () => void;
  const ready = new Promise<void>((resolve) => {
    started = resolve;
  });
  const tts = createDiscordTts({
    execute: async (_, text, signal) => {
      texts.push(text);
      if (text === "первый") {
        started();
        await new Promise<void>((resolve) =>
          signal.addEventListener("abort", () => resolve(), { once: true }),
        );
      }
    },
  });
  const first = tts.handle(message("!tts первый").request);
  await ready;
  const second = tts.handle(message("!tts второй").request);
  await Bun.sleep(1);
  expect(tts.busy("tts-test")).toBe(true);
  await tts.handle(message("!tts stop").request);
  await Promise.all([first, second]);
  await tts.handle(message("!tts третий").request);
  expect(texts).toEqual(["первый", "третий"]);
  await tts.stop();
});

test("reading the bot's own reply speaks without a chat acknowledgment", async () => {
  const texts: string[] = [];
  const { request, replies } = message("!tts");
  Object.defineProperty(request, "client", { value: { user: { id: "bot" } } });
  request.fetchReference = async () =>
    fixture<Awaited<ReturnType<Message["fetchReference"]>>>({
      content: "Мой ответ",
      author: { id: "bot", bot: true },
    });
  const tts = createDiscordTts({
    execute: async (_, text) => {
      texts.push(text);
    },
  });
  await tts.handle(request);
  expect(texts).toEqual(["Мой ответ"]);
  expect(replies).toEqual([]);
  await tts.stop();
});
