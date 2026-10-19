/** @file Verify voice-file command routing, platform payloads and PCM metadata. */
import { expect, test, onTestFinished } from "bun:test";
import { Events, MessageFlags, type ClientUser } from "discord.js";
import { createDiscordBot, createTelegramBot, createTelegramApi, fixture } from "./fixtures.ts";
import { voiceMetadata, createVoiceSynthesizer } from "../src/adapters/piper.ts";

/** Minimal encoded recording; platform tests inject synthesis without running external programs. */
const recording = () => ({
  audio: new Blob(["OggS"], { type: "audio/ogg" }),
  duration: 1.5,
  waveform: "AQID",
});

test("Discord !voice replies with a native voice message and requires no voice channel or LLM", async () => {
  const texts: string[] = [];
  const payloads: Record<string, any>[] = [];
  const bot = createDiscordBot({
    config: {},
    assistant: {},
    generateVoice: async (text) => {
      texts.push(text);
      return recording();
    },
  });
  onTestFinished(() => bot.client.destroy());
  bot.client.user = fixture<ClientUser>({ id: "bot" });
  const handle = bot.client.listeners(Events.MessageCreate)[0];
  await handle({
    content: "!voice",
    author: { id: "user" },
    reference: { messageId: "original" },
    fetchReference: async () => ({ content: "Ответ бота", author: { id: "bot" } }),
    reply: async (payload: Record<string, any>) => {
      payloads.push(payload);
    },
  });
  expect(texts).toEqual(["Ответ бота"]);
  expect(payloads).toHaveLength(1);
  expect(payloads[0].flags).toBe(MessageFlags.IsVoiceMessage);
  expect(payloads[0].content).toBeUndefined();
  expect(payloads[0].files[0].duration).toBe(1.5);
  expect(payloads[0].files[0].waveform).toBe("AQID");
  expect(payloads[0].files[0].name).toBe("voice.ogg");
});

test("Telegram !voice preserves topic and reply, supports addressed commands and rejects another bot's command", async () => {
  const texts: string[] = [];
  const calls: { method: string; payload: Record<string, any> }[] = [];
  const bot = createTelegramBot({
    config: {},
    assistant: {},
    generateVoice: async (text) => {
      texts.push(text);
      return recording();
    },
    api: async (method, payload) => {
      if (method === "getMe") return { id: 99, username: "testbot" };
      calls.push({ method, payload });
      return {};
    },
  });
  const base = {
    message_id: 7,
    message_thread_id: 4,
    from: { id: 1 },
    chat: { id: -10, type: "supergroup" as const },
  };
  await bot.handleUpdate({
    message: { ...base, text: "!voice@testbot", reply_to_message: { caption: "Читай подпись" } },
  });
  await bot.handleUpdate({ message: { ...base, text: "!voice Явный текст" } });
  await bot.handleUpdate({ message: { ...base, text: "!voice@otherbot Не читай" } });
  expect(texts).toEqual(["Читай подпись", "Явный текст"]);
  expect(calls).toHaveLength(2);
  expect(calls[0].method).toBe("sendVoice");
  expect(calls[0].payload.voice).toBeInstanceOf(Blob);
  expect(calls[0].payload.duration).toBe(2);
  expect(calls[0].payload.message_thread_id).toBe(4);
  expect(calls[0].payload.reply_parameters.message_id).toBe(7);
});

test("voice commands validate text before synthesis and do not fall through to LLM", async () => {
  const calls: string[] = [];
  const bot = createTelegramBot({
    config: {},
    assistant: {},
    generateVoice: async () => {
      throw new Error("must not synthesize");
    },
    api: async (method) => {
      if (method === "getMe") return { id: 99 };
      calls.push(method);
      return {};
    },
  });
  for (const text of ["!voice", "!voice " + "я".repeat(2001)])
    await bot.handleUpdate({
      message: { message_id: 1, from: { id: 1 }, chat: { id: 1, type: "private" }, text },
    });
  expect(calls).toEqual(["sendMessage", "sendMessage"]);
});

test("Telegram sends synthesized voice bytes as multipart input rather than a JSON Blob", async () => {
  const api = createTelegramApi("test-token", async (_, init) => {
    expect(new Headers(init.headers).get("content-type")).toContain("multipart/form-data");
    const body = await new Response(init.body).text();
    expect(body).toContain("voice.ogg");
    expect(body).toContain("OggS");
    return Response.json({ ok: true, result: { message_id: 1 } });
  });
  await api("sendVoice", { chat_id: 1, voice: recording().audio });
});

test("waveform and duration reflect real PCM samples, including the negative amplitude extreme", () => {
  const pcm = new ArrayBuffer(48000 * 4);
  const samples = new DataView(pcm);
  samples.setInt16(0, -32768, true);
  const metadata = voiceMetadata(pcm);
  expect(metadata.duration).toBe(1);
  const waveform = Uint8Array.fromBase64(metadata.waveform);
  expect(waveform).toHaveLength(10);
  expect(waveform[0]).toBe(255);
  expect(waveform[1]).toBe(0);
});

test("voice synthesis rejects invalid text and requests after shutdown", async () => {
  const voice = createVoiceSynthesizer();
  await expect(voice.generate("")).rejects.toThrow();
  await expect(voice.generate("я".repeat(2001))).rejects.toThrow();
  await voice.stop();
  await expect(voice.generate("Привет")).rejects.toThrow();
});
