/** @file Snake routing and sandbox gameplay regressions without Telegram network access. */
import type { Message } from "@grammyjs/types";
import { mkdtemp, rm } from "node:fs/promises";
import { expect, test, onTestFinished } from "bun:test";
import { createContext, runInContext } from "node:vm";
import { SNAKE_HTML, handleTelegramSnake } from "../../src/adapters/telegram/snake.ts";
import { createTelegramApi } from "../../src/adapters/telegram/api.ts";
import { setup, message } from "../support/telegram-fixture.ts";

test("snake sends a widget in a private topic without invoking the assistant", async () => {
  const directory = await mkdtemp("/tmp/telegram-snake-");
  onTestFinished(() => rm(directory, { recursive: true, force: true }));
  const { bot, calls, inputs } = setup(undefined, undefined, directory);
  await bot.handleUpdate({
    message: { ...message(1, " !Snake@TestBot "), message_thread_id: 7 },
  });
  expect(inputs).toHaveLength(0);
  expect(calls.find((call) => call.method === "sendWidget")?.payload as unknown).toEqual({
    chat_id: 1,
    message_thread_id: 7,
    reply_parameters: { message_id: 1, allow_sending_without_reply: true },
    html: SNAKE_HTML,
    is_shared: true,
    allow_queries: true,
    public_data: "[]",
  });
  expect(new TextEncoder().encode(SNAKE_HTML).length).toBeLessThanOrEqual(32768);
  expect(Bun.deflateSync(SNAKE_HTML, { level: 9 }).length).toBeLessThanOrEqual(4096);
});

test("group snake explains the private-chat restriction without invoking the assistant", async () => {
  const { bot, calls, inputs } = setup();
  await bot.handleUpdate({ message: message(1, "!snake", { id: 2, type: "group" }) });
  expect(inputs).toHaveLength(0);
  expect(calls.some((call) => call.method === "sendWidget")).toBe(false);
  expect(calls.find((call) => call.method === "sendMessage")?.payload.text).toContain("@testbot");
});

test("snake ignores other bots and non-command text", async () => {
  for (const text of ["!snake@other", "!snake extra", "!snakeoil", "play !snake"]) {
    expect(
      await handleTelegramSnake(message(1, text) as Message, "testbot", async () => {
        throw new Error("unexpected API request");
      }),
    ).toBe(false);
  }
});

test("widget delivery failures get a text reply", async () => {
  const calls: string[] = [];
  await handleTelegramSnake(message(1, "!snake") as Message, "testbot", async (method) => {
    calls.push(method);
    if (method === "sendWidget") throw new Error("unsupported");
  });
  expect(calls).toEqual(["sendWidget", "sendMessage"]);
});

test("widget supports gameplay and leaderboard requests", async () => {
  const handlers = new Map<string, () => void>();
  const nodes = new Map<string, { textContent: string; [key: string]: unknown }>();
  const document = {
    hidden: false,
    querySelector(id: string) {
      if (!nodes.has(id))
        nodes.set(id, {
          textContent: id === "#restart" ? "Старт" : "",
          style: { display: id === "#ranking" ? "none" : "block" },
          getContext: () => ({ fillRect() {}, fillStyle: "" }),
          addEventListener: (event: string, callback: () => void) =>
            handlers.set(id + event, callback),
        });
      return nodes.get(id);
    },
    addEventListener: (event: string, callback: () => void) => handlers.set(event, callback),
  };
  const requests: string[] = [];
  const widget = {
    publicData: JSON.stringify([["<b>Игрок</b>", 8]]),
    ready() {},
    onEvent() {},
    watchPublicData() {},
    request(data: string): Promise<{ result: string }> {
      requests.push(data);
      return Promise.resolve({ result: JSON.stringify({ top: [["Лучший", 10]] }) });
    },
  };
  const sandbox = createContext({ document, window: { TelegramWidget: widget }, setInterval() {} });
  runInContext(SNAKE_HTML.match(/<script>([\s\S]*?)<\/script>/u)[1], sandbox);
  const run = (code: string) => runInContext(code, sandbox);
  const click = (id: string) => handlers.get("#" + id + "click")();
  expect(run("running")).toBe(false);
  click("restart");
  run("food = 105; tick()");
  expect(run("snake.length")).toBe(4);
  expect(nodes.get("#score").textContent).toBe("Счёт: 1");
  click("left");
  expect(run("next")).toBe(1);
  click("up");
  click("left");
  expect(run("next")).toBe(-14);
  run("tick()");
  click("pause");
  const head = run("snake[0]");
  run("tick()");
  expect(run("snake[0]")).toBe(head);
  click("pause");
  document.hidden = true;
  handlers.get("visibilitychange")();
  expect(run("running")).toBe(false);
  document.hidden = false;
  click("restart");
  run("snake = [111, 110, 109]; food = 0; tick()");
  expect(run("over && !running")).toBe(true);
  click("restart");
  run("snake = [30, 31, 45, 44, 43, 29]; direction = next = 1; food = 0; tick()");
  expect(run("over && !running")).toBe(true);
  click("restart");
  run("snake = [30, 31, 45, 44]; direction = next = 14; food = 0; tick()");
  expect(run("running && snake[0] === 44")).toBe(true);
  expect(nodes.get("#leaders").textContent).toContain("<b>Игрок</b>");
  click("refresh");
  expect(run("running")).toBe(false);
  await Promise.resolve();
  await Promise.resolve();
  expect(requests).toEqual(["snake:top"]);
  expect(nodes.get("#leaders").textContent).toContain("Лучший");
  click("submit");
  expect(requests).toHaveLength(1);
  run("over = true");
  click("submit");
  await Promise.resolve();
  await Promise.resolve();
  expect(requests.at(-1)).toBe("snake:score:1");
  expect(nodes.get("#notice").textContent).toBe("Результат сохранён");
  widget.request = () => Promise.reject(new Error("timeout"));
  click("submit");
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  expect(nodes.get("#notice").textContent).toContain("Нажмите ещё раз");
});

test("grammY transport passes sendWidget and its HTML to Bot API", async () => {
  let body: Record<string, unknown>;
  const api = createTelegramApi("secret", async (url, options) => {
    expect(String(url)).toEndWith("/sendWidget");
    body = JSON.parse(String(options.body));
    return new Response(JSON.stringify({ ok: true, result: { message_id: 2 } }));
  });
  await api("sendWidget", { chat_id: 1, html: SNAKE_HTML });
  expect(body).toEqual({ chat_id: 1, html: SNAKE_HTML });
});

test("bundled widget preserves Unicode labels instead of displaying escape sequences", async () => {
  const result = await Bun.build({
    entrypoints: ["./src/adapters/telegram/snake.ts"],
    target: "bun",
  });
  expect(result.success).toBe(true);
  const bundled = await import(
    `data:text/javascript;base64,${Buffer.from(await result.outputs[0].text()).toString("base64")}`
  );
  expect(bundled.SNAKE_HTML).toContain('aria-label="Вправо">→</button>');
  expect(bundled.SNAKE_HTML).toContain("🐍 Змейка");
  expect(bundled.SNAKE_HTML).not.toMatch(/\\u[\da-f]{4}/iu);
});
