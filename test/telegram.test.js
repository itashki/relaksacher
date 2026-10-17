/** @file Regression tests for telegram.test. */
import test from "node:test";
import assert from "node:assert/strict";
import { createTelegramBot, createTelegramApi } from "../src/adapters/telegram.js";

/**
 * Build an injected Telegram adapter with no external network requests.
 * @param {Function} [run] Custom fake session execution.
 * @param {object} [config] Telegram adapter settings.
 * @returns {object} Bot fixture, API calls and captured session options.
 */
function setup(run, config = { telegramUpdateIntervalMs: 0 }) {
  const calls = [];
  const inputs = [];
  const bot = createTelegramBot({ config, api: async (method, payload = {}) => {
    calls.push({ method, payload });
    if (method === "getMe") return { id: 99, username: "testbot", is_bot: true };
    if (method === "getChatMember") return { status: "member" };
    return { message_id: calls.length, text: payload.text };
  }, assistant: { createSession(options) {
    inputs.push(options);
    return { stop() { calls.push({ method: "stopped" }); }, async run() {
      if (run) return run(options, bot);
      await options.onUpdate({ text: "", modelAlias: "терн", final: false });
      await options.onUpdate({ text: "answer", modelAlias: "терн", final: true });
      return { text: "answer", thinkingLog: "" };
    } };
  } } });
  return { bot, calls, inputs };
}
/**
 * Build a minimal user-authored Telegram message for adapter tests.
 * @param {number} id Message identifier.
 * @param {string|undefined} text Text or undefined for image-only fixtures.
 * @param {object} [chat] Chat metadata.
 * @returns {object} Message fixture.
 */
const message = (id, text, chat = { id: 1, type: "private" }) => ({
  message_id: id, text, chat, from: { id: 10, first_name: "Alice" },
});

test("private chats render the model signature and do not include unrelated previous messages", async () => {
  const { bot, calls, inputs } = setup();
  await bot.handleUpdate({ message: message(1, "hello /think") });
  const send = calls.find((c) => c.method === "sendMessage");
  assert.equal(send.payload.text, "…\n\n· терн");
  assert.equal(send.payload.reply_markup.inline_keyboard.length, 1);
  assert.equal(inputs[0].think, true);
  assert.equal(inputs[0].context.scopeId, undefined);
  await bot.handleUpdate({ message: message(100, "next") });
  assert.equal(inputs[1].conversation.length, 1);
  assert.match(inputs[1].conversation[0].content, /next/);
  assert.deepEqual(inputs[1].background, []);
  assert.ok(calls.some((c) => c.method === "editMessageText" && c.payload.text === "answer\n\n· терн"));
});

test("group messages outside the reply chain are excluded", async () => {
  const { bot, inputs } = setup();
  const chat = { id: -123, type: "supergroup" };
  await bot.handleUpdate({ message: { ...message(1, "chatter", chat), message_thread_id: 2 } });
  await bot.handleUpdate({ message: { ...message(2, "other topic", chat), message_thread_id: 3 } });
  assert.equal(inputs.length, 0);
  const addressed = { ...message(3, "@testbot question", chat), message_thread_id: 2,
    entities: [{ type: "mention", offset: 0, length: 8 }] };
  await bot.handleUpdate({ message: addressed });
  assert.equal(inputs[0].context.scopeId, "telegram_-123");
  assert.deepEqual(inputs[0].background, []);
  assert.equal(inputs[0].conversation.length, 1);
});

test("stop callbacks reject strangers and allow the requesting author", async () => {
  const { bot, calls } = setup(async (options, instance) => {
    await options.onUpdate({ text: "", modelAlias: "шип", final: false });
    for (const user of [20, 10]) await instance.handleUpdate({ callback_query: {
      id: String(user), data: "stop:1:1", from: { id: user }, message: { chat: { id: 1, type: "private" } },
    } });
    return { text: "stopped" };
  });
  await bot.handleUpdate({ message: message(1, "question") });
  assert.equal(calls.filter((c) => c.method === "stopped").length, 1);
  assert.match(calls.find((c) => c.method === "answerCallbackQuery").payload.text, /автор/);
});

test("long replies respect Telegram text limits and thinking is not sent", async () => {
  const { bot, calls } = setup(async (options) => {
    await options.onUpdate({ text: "😀".repeat(3000), modelAlias: "жало", final: true });
    return { text: "😀".repeat(3000), thinkingLog: "reasoning" };
  });
  await bot.handleUpdate({ message: message(1, "question") });
  const sends = calls.filter((c) => c.method === "sendMessage");
  assert.equal(sends.length, 2);
  assert.ok(sends.every((c) => c.payload.text.length <= 4096));
  assert.ok(!calls.some((c) => c.method === "sendDocument"));
});

test("Telegram transport redacts token-bearing fetch errors", async () => {
  const api = createTelegramApi("secret-token", async () => { throw new Error("URL contains secret-token"); });
  await assert.rejects(api("getMe"), (error) => !error.message.includes("secret-token"));
});

test("Telegram retries a failed edit but does not retry sending new messages", async () => {
  let attempts = 0;
  const api = createTelegramApi("secret", async () => {
    attempts++;
    if (attempts === 1) throw new Error("connection lost");
    return { json: async () => ({ ok: true, result: true }) };
  });
  assert.equal(await api("editMessageText", { chat_id: 1, message_id: 2, text: "answer" }), true);
  assert.equal(attempts, 2);
  attempts = 0;
  await assert.rejects(api("sendMessage", { chat_id: 1, text: "answer" }));
  assert.equal(attempts, 1);
});

test("temporary streaming edit failure does not interrupt generation or lose final text", async (t) => {
  t.mock.method(console, "warn", () => {});
  let edits = 0;
  let completed = false;
  const bot = createTelegramBot({ config: { telegramUpdateIntervalMs: 0 }, api: async (method, payload) => {
    if (method === "getMe") return { id: 99, username: "testbot" };
    if (method === "sendMessage") return { message_id: 2 };
    if (method === "editMessageText") {
      if (++edits === 1) throw Object.assign(new Error("connection failed"), { transient: true });
      assert.equal(payload.text, "complete answer");
    }
    return true;
  }, assistant: { createSession({ onUpdate }) {
    return { stop() {}, async run() {
      await onUpdate({ text: "", final: false });
      await onUpdate({ text: "partial", final: false });
      await onUpdate({ text: "complete answer", final: true });
      completed = true;
      return { text: "complete answer" };
    } };
  } } });
  await bot.handleUpdate({ message: message(1, "question") });
  assert.equal(completed, true);
  assert.equal(edits, 2);
});

test("Telegram photos and image replies reach the core as images", async () => {
  const inputs = [];
  const loaded = [];
  const api = async (method) => method === "getMe" ? { id: 99, username: "testbot" } : true;
  api.downloadImage = async (file) => { loaded.push(file); return "base64-image"; };
  const bot = createTelegramBot({ config: {}, api, assistant: { createSession(options) {
    inputs.push(options);
    return { stop() {}, async run() { return { text: "description" }; } };
  } } });
  const photo = { ...message(1, undefined), photo: [{ file_id: "small" }, { file_id: "large" }] };
  await bot.handleUpdate({ message: photo });
  assert.deepEqual(loaded, ["large"]);
  assert.deepEqual(inputs[0].conversation[0].images, ["base64-image"]);
  assert.match(inputs[0].conversation[0].content, /Опиши изображение/);
  await bot.handleUpdate({ message: { ...message(2, "what color?"), reply_to_message: photo } });
  assert.deepEqual(inputs[1].conversation[0].images, ["base64-image"]);
});

test("grammY uploads thinking.md as multipart and handles Telegram rate limits", async () => {
  const uploads = [];
  const api = createTelegramApi("test-token", async (_url, init) => {
    uploads.push({ type: init.headers["content-type"] ?? init.headers["Content-Type"], body: await new Response(init.body).text() });
    return { json: async () => ({ ok: true, result: { message_id: 1 } }) };
  });
  await api("sendDocument", { chat_id: 1, document: new Blob(["reasoning"], { type: "text/markdown" }) });
  assert.match(uploads[0].type, /multipart\/form-data/);
  assert.match(uploads[0].body, /thinking.md/);
  assert.match(uploads[0].body, /reasoning/);
  let calls = 0;
  const limited = createTelegramApi("test-token", async () => ({ json: async () => ++calls === 1
    ? { ok: false, error_code: 429, description: "Too many requests", parameters: { retry_after: 0 } }
    : { ok: true, result: true } }));
  assert.equal(await limited("sendMessage", { chat_id: 1, text: "hello" }), true);
  assert.equal(calls, 2);
});

test("grammY runner receives stop callbacks while generation is running", async (t) => {
  t.mock.method(console, "log", () => {});
  let startGeneration;
  const started = new Promise((resolve) => { startGeneration = resolve; });
  let finishGeneration;
  const finished = new Promise((resolve) => { finishGeneration = resolve; });
  let callbackAnswered;
  const answered = new Promise((resolve) => { callbackAnswered = resolve; });
  let polls = 0;
  const api = async (method, payload, signal) => {
    if (method === "getMe") return { id: 99, username: "testbot" };
    if (method === "getUpdates") {
      if (++polls === 1) return [{ update_id: 1, message: message(1, "question") }];
      if (polls === 2) {
        await started;
        return [{ update_id: 2, callback_query: { id: "callback", data: "stop:1:1", from: { id: 10 }, message: { chat: { id: 1, type: "private" } } } }];
      }
      return new Promise((resolve) => {
        if (signal.aborted) resolve([]);
        else signal.addEventListener("abort", () => resolve([]), { once: true });
      });
    }
    if (method === "answerCallbackQuery") callbackAnswered();
    return true;
  };
  const bot = createTelegramBot({ config: {}, api, assistant: { createSession() {
    return { stop: finishGeneration, async run() { startGeneration(); await finished; return { text: "stopped" }; } };
  } } });
  t.after(() => bot.stop());
  const running = bot.start();
  await answered;
  await bot.stop();
  await running;
  assert.ok(polls >= 2);
});

test("Telegram keeps cached ancestors only when explicitly replying", async () => {
  const { bot, inputs, calls } = setup();
  await bot.handleUpdate({ message: message(1, "original question") });
  const botReply = calls.find((call) => call.method === "sendMessage");
  // setup returns calls.length as the sent message id (getMe then sendMessage).
  const replyId = 2;
  assert.ok(botReply);
  await bot.handleUpdate({ message: {
    ...message(100, "follow-up"), reply_to_message: {
      message_id: replyId, text: "answer", from: { id: 99, username: "testbot", is_bot: true },
    },
  } });
  assert.equal(inputs[1].conversation.length, 3);
  assert.match(inputs[1].conversation[0].content, /original question/);
  assert.equal(inputs[1].conversation[1].role, "assistant");
  assert.match(inputs[1].conversation[2].content, /follow-up/);
});

test("getMe uses grammY's signal-only signature and reaches the transport", async () => {
  let calls = 0;
  const api = createTelegramApi("test-token", async (url, init) => {
    calls++;
    assert.ok(String(url).endsWith("/getMe"));
    assert.equal(typeof init.signal.addEventListener, "function");
    assert.equal(init.signal.aborted, false);
    return { json: async () => ({ ok: true, result: { id: 99, username: "testbot" } }) };
  });
  const me = await api("getMe");
  assert.equal(me.username, "testbot");
  assert.equal(calls, 1);
});

test("a temporary getMe network failure is retried and stays identifiable", async () => {
  let calls = 0;
  const api = createTelegramApi("secret-token", async () => {
    if (++calls === 1) throw new Error("network failure with secret-token");
    return { json: async () => ({ ok: true, result: { id: 99 } }) };
  });
  assert.equal((await api("getMe")).id, 99);
  assert.equal(calls, 2);
  const invalidToken = createTelegramApi("secret-token", async () => ({
    json: async () => ({ ok: false, error_code: 401, description: "Unauthorized" }),
  }));
  await assert.rejects(invalidToken("getMe"), (error) => error.code === 401 && !error.transient);
});

test("grammY transport works with native Node fetch, not only fetch mocks", async () => {
  const result = { ok: true, result: { id: 99, username: "testbot" } };
  const dataUrl = `data:application/json,${encodeURIComponent(JSON.stringify(result))}`;
  const api = createTelegramApi("test-token", (_url, options) => fetch(dataUrl, options));
  assert.equal((await api("getMe")).username, "testbot");
});

test("native signal bridge forwards request cancellation", async () => {
  let transportStarted;
  const started = new Promise((resolve) => { transportStarted = resolve; });
  const api = createTelegramApi("test-token", async (_url, options) => {
    assert.ok(options.signal instanceof AbortSignal);
    transportStarted();
    return new Promise((resolve, reject) => {
      options.signal.addEventListener("abort", () => reject(new Error("cancelled")), { once: true });
    });
  });
  const controller = new AbortController();
  const request = api("getMe", {}, controller.signal);
  await started;
  controller.abort();
  await assert.rejects(request, (error) => !error.transient && /cancelled/.test(error.message));
});

test("real runner signals work through grammY and native fetch to deliver messages", async (t) => {
  t.mock.method(console, "log", () => {});
  let delivered;
  const received = new Promise((resolve) => { delivered = resolve; });
  let polls = 0;
  const api = createTelegramApi("test-token", async (url, options) => {
    const method = String(url).split("/").at(-1);
    let result;
    if (method === "getMe") result = { id: 99, username: "testbot" };
    else if (method === "getUpdates") {
      if (++polls === 1) result = [{ update_id: 1, message: message(1, "hello from polling") }];
      else return new Promise((resolve, reject) => {
        if (options.signal.aborted) reject(new Error("aborted"));
        else options.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      });
    } else result = true;
    return fetch(`data:application/json,${encodeURIComponent(JSON.stringify({ ok: true, result }))}`, options);
  });
  const bot = createTelegramBot({ config: {}, api, assistant: { createSession(options) {
    delivered(options);
    return { stop() {}, async run() { return { text: "answer" }; } };
  } } });
  t.after(() => bot.stop());
  const started = bot.start();
  const options = await received;
  assert.match(options.conversation.at(-1).content, /hello from polling/);
  await bot.stop();
  await started;
  assert.ok(polls >= 1);
});

test("Telegram throttles intermediate edits but sends initial and final snapshots immediately", async (t) => {
  let now = 10000;
  t.mock.method(Date, "now", () => now);
  const { bot, calls } = setup(async ({ onUpdate }) => {
    await onUpdate({ text: "", modelAlias: "терн", final: false });
    for (const delta of [100, 1000, 3000]) {
      now = 10000 + delta;
      await onUpdate({ text: `partial ${delta}`, final: false });
    }
    now = 15000;
    await onUpdate({ text: "latest partial", final: false });
    now = 15100;
    await onUpdate({ text: "complete", final: true });
    return { text: "complete" };
  }, { telegramUpdateIntervalMs: 5000 });
  await bot.handleUpdate({ message: message(1, "question") });
  assert.equal(calls.filter((call) => call.method === "sendMessage").length, 1);
  assert.deepEqual(calls.filter((call) => call.method === "editMessageText").map((call) => call.payload.text),
    ["latest partial", "complete"]);
  assert.equal(calls.filter((call) => call.method === "editMessageReplyMarkup").length, 0);
});

test("selected reply fragment is passed separately from the user's request and commands", async () => {
  const { bot, inputs } = setup();
  await bot.handleUpdate({ message: {
    ...message(100, "Что ты имел в виду?"),
    reply_to_message: { message_id: 50, text: "first topic; /search second topic", from: { id: 99, username: "testbot", is_bot: true } },
    quote: { text: "/search second topic", position: 13, is_manual: true },
  } });
  const current = inputs[0].conversation.at(-1).content;
  assert.match(current, /Цитируемый фрагмент/);
  assert.match(current, /"text":"\/search second topic"/);
  assert.match(current, /"manuallySelected":true/);
  assert.match(current, /"messageId":50/);
  assert.match(current, /Текст реплики:\nЧто ты имел в виду/);
  assert.equal(inputs[0].search, undefined);
  assert.equal(inputs[0].conversation[0].content, "first topic; /search second topic");
});

test("quoted fragment is retained even when the original message is inaccessible", async () => {
  const { bot, inputs } = setup();
  await bot.handleUpdate({ message: { ...message(101, "Объясни это"),
    quote: { text: "fragment from another chat", position: 0 },
    external_reply: { message_id: 33 },
  } });
  assert.equal(inputs[0].conversation.length, 1);
  assert.match(inputs[0].conversation[0].content, /fragment from another chat/);
  assert.match(inputs[0].conversation[0].content, /"manuallySelected":false/);
});
