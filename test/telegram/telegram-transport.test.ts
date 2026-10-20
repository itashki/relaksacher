/** @file Regression coverage for telegram transport behavior. */
import type { TestSessionOptions } from "../support/fixtures.ts";
import { spyOn, expect, test, onTestFinished } from "bun:test";
import { createTelegramBot, createTelegramApi } from "../support/fixtures.ts";
import { setup, message, type TelegramPayload } from "../support/telegram-fixture.ts";

test("Telegram transport redacts token-bearing fetch errors", async () => {
  const api = createTelegramApi("secret-token", async () => {
    throw new Error("URL contains secret-token");
  });
  await expect(api("getMe")).rejects.toMatchObject({
    message: expect.not.stringContaining("secret-token"),
  });
});

test("Telegram retries a failed edit but does not retry sending new messages", async () => {
  let attempts = 0;
  const api = createTelegramApi("secret", async () => {
    attempts++;
    if (attempts === 1) throw new Error("connection lost");
    return { json: async () => ({ ok: true, result: true }) };
  });
  expect(await api("editMessageText", { chat_id: 1, message_id: 2, text: "answer" })).toBe(true);
  expect(attempts).toBe(2);
  attempts = 0;
  await expect(api("sendMessage", { chat_id: 1, text: "answer" })).rejects.toThrow();
  expect(attempts).toBe(1);
});

test("temporary streaming edit failure does not interrupt generation or lose final text", async () => {
  const spy = spyOn(console, "warn").mockImplementation(() => {});
  onTestFinished(() => spy.mockRestore());
  let edits = 0;
  let completed = false;
  const bot = createTelegramBot({
    config: { telegramUpdateIntervalMs: 0 },
    api: async (method, payload) => {
      if (method === "getMe") return { id: 99, username: "testbot" };
      if (method === "sendMessage") return { message_id: 2 };
      if (method === "editMessageText") {
        if (++edits === 1) throw Object.assign(new Error("connection failed"), { transient: true });
        expect(payload.text).toBe("complete answer");
      }
      return true;
    },
    assistant: {
      createSession({ onUpdate }) {
        return {
          stop() {},
          async run() {
            await onUpdate({ text: "", final: false });
            await onUpdate({ text: "partial", final: false });
            await onUpdate({ text: "complete answer", final: true });
            completed = true;
            return { text: "complete answer" };
          },
        };
      },
    },
  });
  await bot.handleUpdate({ message: message(1, "question") });
  expect(completed).toBe(true);
  expect(edits).toBe(2);
});

test("grammY uploads thinking.md as multipart and handles Telegram rate limits", async () => {
  const uploads: { type: string; body: string }[] = [];
  const api = createTelegramApi("test-token", async (_url, init) => {
    uploads.push({
      type: new Headers(init.headers).get("content-type"),
      body: await new Response(init.body).text(),
    });
    return { json: async () => ({ ok: true, result: { message_id: 1 } }) };
  });
  await api("sendDocument", {
    chat_id: 1,
    document: new Blob(["reasoning"], { type: "text/markdown" }),
  });
  expect(uploads[0].type).toMatch(/multipart\/form-data/);
  expect(uploads[0].body).toMatch(/thinking.md/);
  expect(uploads[0].body).toMatch(/reasoning/);
  let calls = 0;
  const limited = createTelegramApi("test-token", async () => ({
    json: async () =>
      ++calls === 1
        ? {
            ok: false,
            error_code: 429,
            description: "Too many requests",
            parameters: { retry_after: 0 },
          }
        : { ok: true, result: true },
  }));
  expect(await limited("sendMessage", { chat_id: 1, text: "hello" })).toBe(true);
  expect(calls).toBe(2);
});

test("grammY runner receives stop callbacks while generation is running", async () => {
  const spy = spyOn(console, "log").mockImplementation(() => {});
  onTestFinished(() => spy.mockRestore());
  let startGeneration: () => void;
  const started = new Promise<void>((resolve) => {
    startGeneration = resolve;
  });
  let finishGeneration: () => void;
  const finished = new Promise<void>((resolve) => {
    finishGeneration = resolve;
  });
  let callbackAnswered: () => void;
  const answered = new Promise<void>((resolve) => {
    callbackAnswered = resolve;
  });
  let polls = 0;
  const api = async (method: string, _payload: TelegramPayload, signal: AbortSignal) => {
    if (method === "getMe") return { id: 99, username: "testbot" };
    if (method === "getUpdates") {
      if (++polls === 1) return [{ update_id: 1, message: message(1, "question") }];
      if (polls === 2) {
        await started;
        return [
          {
            update_id: 2,
            callback_query: {
              id: "callback",
              data: "stop:1:1",
              from: { id: 10 },
              message: { chat: { id: 1, type: "private" } },
            },
          },
        ];
      }
      return new Promise<unknown[]>((resolve) => {
        if (signal.aborted) resolve([]);
        else signal.addEventListener("abort", () => resolve([]), { once: true });
      });
    }
    if (method === "answerCallbackQuery") callbackAnswered();
    return true;
  };
  const bot = createTelegramBot({
    config: {},
    api,
    assistant: {
      createSession() {
        return {
          stop: finishGeneration,
          async run() {
            startGeneration();
            await finished;
            return { text: "stopped" };
          },
        };
      },
    },
  });
  onTestFinished(() => bot.stop());
  const running = bot.start();
  await answered;
  await bot.stop();
  await running;
  expect(polls >= 2).toBeTruthy();
});

test("getMe uses grammY's signal-only signature and reaches the transport", async () => {
  let calls = 0;
  const api = createTelegramApi("test-token", async (url, init) => {
    calls++;
    expect(String(url).endsWith("/getMe")).toBeTruthy();
    expect(typeof init.signal.addEventListener).toBe("function");
    expect(init.signal.aborted).toBe(false);
    return { json: async () => ({ ok: true, result: { id: 99, username: "testbot" } }) };
  });
  const me = await api("getMe");
  expect(me.username).toBe("testbot");
  expect(calls).toBe(1);
});

test("a temporary getMe network failure is retried and stays identifiable", async () => {
  let calls = 0;
  const api = createTelegramApi("secret-token", async () => {
    if (++calls === 1) throw new Error("network failure with secret-token");
    return { json: async () => ({ ok: true, result: { id: 99 } }) };
  });
  expect((await api("getMe")).id).toBe(99);
  expect(calls).toBe(2);
  const invalidToken = createTelegramApi("secret-token", async () => ({
    json: async () => ({ ok: false, error_code: 401, description: "Unauthorized" }),
  }));
  await expect(invalidToken("getMe")).rejects.toMatchObject({ code: 401, transient: false });
});

test("grammY transport works with native Bun fetch, not only fetch mocks", async () => {
  const result = { ok: true, result: { id: 99, username: "testbot" } };
  const dataUrl = `data:application/json,${encodeURIComponent(JSON.stringify(result))}`;
  const api = createTelegramApi("test-token", (_url, options) => fetch(dataUrl, options));
  expect((await api("getMe")).username).toBe("testbot");
});

test("native signal bridge forwards request cancellation", async () => {
  let transportStarted: () => void;
  const started = new Promise<void>((resolve) => {
    transportStarted = resolve;
  });
  const api = createTelegramApi("test-token", async (_url, options) => {
    expect(options.signal instanceof AbortSignal).toBeTruthy();
    transportStarted();
    return new Promise((_resolve, reject) => {
      options.signal.addEventListener("abort", () => reject(new Error("cancelled")), {
        once: true,
      });
    });
  });
  const controller = new AbortController();
  const request = api("getMe", {}, controller.signal);
  await started;
  controller.abort();
  await expect(request).rejects.toMatchObject({
    transient: false,
    message: expect.stringMatching(/cancelled/),
  });
});

test("real runner signals work through grammY and native fetch to deliver messages", async () => {
  const spy = spyOn(console, "log").mockImplementation(() => {});
  onTestFinished(() => spy.mockRestore());
  let delivered: (options: TestSessionOptions) => void;
  const received = new Promise<TestSessionOptions>((resolve) => {
    delivered = resolve;
  });
  let polls = 0;
  const api = createTelegramApi("test-token", async (url, options) => {
    const method = String(url).split("/").at(-1);
    let result;
    if (method === "getMe") result = { id: 99, username: "testbot" };
    else if (method === "getUpdates") {
      if (++polls === 1) result = [{ update_id: 1, message: message(1, "hello from polling") }];
      else
        return new Promise((_resolve, reject) => {
          if (options.signal.aborted) reject(new Error("aborted"));
          else
            options.signal.addEventListener("abort", () => reject(new Error("aborted")), {
              once: true,
            });
        });
    } else result = true;
    return fetch(
      `data:application/json,${encodeURIComponent(JSON.stringify({ ok: true, result }))}`,
      options,
    );
  });
  const bot = createTelegramBot({
    config: {},
    api,
    assistant: {
      createSession(options) {
        delivered(options);
        return {
          stop() {},
          async run() {
            return { text: "answer" };
          },
        };
      },
    },
  });
  onTestFinished(() => bot.stop());
  const started = bot.start();
  const options = await received;
  expect(options.conversation.at(-1).content).toMatch(/hello from polling/);
  await bot.stop();
  await started;
  expect(polls >= 1).toBeTruthy();
});

test("Telegram throttles intermediate edits but sends initial and final snapshots immediately", async () => {
  let now = 10000;
  const spy = spyOn(Date, "now").mockImplementation(() => now);
  onTestFinished(() => spy.mockRestore());
  const { bot, calls } = setup(
    async ({ onUpdate }) => {
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
    },
    { telegramUpdateIntervalMs: 5000 },
  );
  await bot.handleUpdate({ message: message(1, "question") });
  expect(calls.filter((call) => call.method === "sendMessage").length).toBe(1);
  expect(
    calls.filter((call) => call.method === "editMessageText").map((call) => call.payload.text),
  ).toStrictEqual(["latest partial", "complete"]);
  expect(calls.filter((call) => call.method === "editMessageReplyMarkup").length).toBe(0);
});
