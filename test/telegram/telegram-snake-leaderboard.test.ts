/** @file Shared Snake persistence, query validation and concurrent score updates. */
import { mkdtemp, rm } from "node:fs/promises";
import { expect, test, onTestFinished, spyOn } from "bun:test";
import type { Message } from "@grammyjs/types";
import { createTransports } from "../../src/runtime/transports.ts";
import type { AppConfig, TelegramApi } from "../../src/types.ts";
import {
  createTelegramSnake,
  type SnakeQuery,
} from "../../src/adapters/telegram/snake-leaderboard.ts";
import { message, setup } from "../support/telegram-fixture.ts";

async function fixture() {
  const directory = await mkdtemp("/tmp/snake-leaderboard-");
  onTestFinished(() => rm(directory, { recursive: true, force: true }));
  const calls: { method: string; payload: Record<string, unknown> }[] = [];
  const api = Object.assign(
    async (method: string, payload: Record<string, unknown>) => {
      calls.push({ method, payload });
      return { widget: { id: "shared-snake" }, message_id: 2 };
    },
    { downloadImage: async () => "" },
  ) as TelegramApi;
  const snake = createTelegramSnake(directory, api);
  await snake.handleMessage(message(1, "!snake") as Message, "testbot");
  return { directory, calls, api, snake };
}
const query = (id: number, score: string): SnakeQuery => ({
  id: String(id),
  from: { id, first_name: "Игрок " + id, is_bot: false },
  type: { type: "data" },
  data: score,
  widget_id: "shared-snake",
});

test("shared widget id survives restart and copies reuse it", async () => {
  const { directory, api, calls } = await fixture();
  await createTelegramSnake(directory, api).handleMessage(
    message(2, "!snake") as Message,
    "testbot",
  );
  expect(calls.map((call) => call.method)).toEqual(["sendWidget", "sendSharedWidget"]);
  expect(calls[0].payload).toMatchObject({ is_shared: true, allow_queries: true });
  expect(calls[1].payload.widget_id).toBe("shared-snake");
});

test("concurrent scores retain only each player's best and survive restart", async () => {
  const { snake, directory, calls, api } = await fixture();
  await Promise.all([
    snake.handleQuery(query(1, "snake:score:5")),
    snake.handleQuery(query(2, "snake:score:8")),
    snake.handleQuery(query(1, "snake:score:2")),
  ]);
  const saved = await Bun.file(directory + "/telegram-snake.json").json();
  expect(saved.scores.map(({ id, score }: { id: number; score: number }) => [id, score])).toEqual([
    [2, 8],
    [1, 5],
  ]);
  await createTelegramSnake(directory, api).handleQuery(query(1, "snake:top"));
  const answer = calls.filter((call) => call.method === "answerWidgetQuery").at(-1);
  expect(JSON.parse(String(answer.payload.data)).top).toEqual([
    ["Игрок 2", 8],
    ["Игрок 1", 5],
  ]);
  expect(calls.some((call) => call.method === "editSharedWidgetData")).toBe(true);
});

test("rejects malformed scores and foreign widget ids without changing storage", async () => {
  const { snake, directory, calls } = await fixture();
  for (const data of [
    "snake:score:-1",
    "snake:score:194",
    "snake:score:1.5",
    "snake:score:01",
    "snake:score:NaN",
    "other",
  ])
    await snake.handleQuery(query(1, data));
  await snake.handleQuery({ ...query(1, "snake:score:193"), widget_id: "foreign" });
  expect((await Bun.file(directory + "/telegram-snake.json").json()).scores).toEqual([]);
  expect(calls.filter((call) => call.method === "answerWidgetQuery")).toHaveLength(6);
  expect(calls.some((call) => call.method === "editSharedWidgetData")).toBe(false);
});

test("top ten stays bounded and public data fits Telegram's byte limit", async () => {
  const { snake, directory, calls } = await fixture();
  await Bun.write(
    directory + "/telegram-snake.json",
    JSON.stringify({
      widgetId: "shared-snake",
      scores: Array.from({ length: 10 }, (_, i) => ({
        id: i + 1,
        name: "🐍".repeat(12),
        score: i,
      })),
    }),
  );
  await snake.handleQuery({
    ...query(20, "snake:score:193"),
    from: { id: 20, is_bot: false, first_name: "<b>\n" + "🐍".repeat(20) },
  });
  const saved = await Bun.file(directory + "/telegram-snake.json").json();
  expect(saved.scores).toHaveLength(10);
  expect(saved.scores[0].id).toBe(20);
  expect([...saved.scores[0].name]).toHaveLength(12);
  const answer = calls.find((call) => call.method === "answerWidgetQuery");
  const edit = calls.find((call) => call.method === "editSharedWidgetData");
  expect(new TextEncoder().encode(String(answer.payload.data)).length).toBeLessThanOrEqual(1024);
  expect(new TextEncoder().encode(String(edit.payload.public_data)).length).toBeLessThanOrEqual(
    1024,
  );
});

test("corrupt storage is preserved and query receives an error", async () => {
  const { directory, snake, calls } = await fixture();
  await Bun.write(directory + "/telegram-snake.json", "broken");
  await snake.handleQuery(query(1, "snake:score:5"));
  expect(await Bun.file(directory + "/telegram-snake.json").text()).toBe("broken");
  expect(JSON.parse(String(calls.at(-1).payload.data)).error).toBeTruthy();
});

test("adapter routes both widget query update types without invoking the model", async () => {
  const directory = await mkdtemp("/tmp/snake-routing-");
  onTestFinished(() => rm(directory, { recursive: true, force: true }));
  const { bot, inputs, calls } = setup(undefined, undefined, directory);
  await bot.handleUpdate({ message: message(1, "!snake") });
  for (const key of ["widget_query", "shared_widget_query"]) {
    await bot.handleUpdate({ [key]: { ...query(1, "snake:top"), widget_id: "snake-id" } });
  }
  expect(inputs).toHaveLength(0);
  expect(calls.filter((call) => call.method === "answerWidgetQuery")).toHaveLength(2);
});

test("persistent runtime poller subscribes to and delivers widget queries", async () => {
  const delivered = Promise.withResolvers<void>();
  let polls = 0;
  const spy = spyOn(globalThis, "fetch").mockImplementation((async (url, options) => {
    let result: unknown;
    if (String(url).endsWith("/getMe")) result = { id: 99, username: "testbot" };
    else if (++polls === 1) {
      expect(JSON.parse(String(options.body)).allowed_updates).toContain("widget_query");
      expect(JSON.parse(String(options.body)).allowed_updates).toContain("shared_widget_query");
      result = [{ update_id: 1, widget_query: query(1, "snake:top") }];
    } else {
      await new Promise<void>((resolve) => {
        if (options.signal.aborted) resolve();
        else options.signal.addEventListener("abort", () => resolve(), { once: true });
      });
      result = [];
    }
    return new Response(JSON.stringify({ ok: true, result }));
  }) as typeof fetch);
  const transports = createTransports(
    { adapters: ["telegram"], telegramToken: "test" } as AppConfig,
    async (event) => {
      expect(event.kind).toBe("telegram-update");
      delivered.resolve();
    },
  );
  onTestFinished(async () => {
    await transports.stop();
    spy.mockRestore();
  });
  await transports.start();
  await delivered.promise;
  await transports.stop();
});
