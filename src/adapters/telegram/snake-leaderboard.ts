/** @file Atomic Snake top-ten storage and shared-widget delivery/query handling. */
import { rename } from "node:fs/promises";
import type { User } from "@grammyjs/types";
import type { TelegramApi } from "../../types.ts";
import { resolvePath } from "../../core/paths.ts";
import { handleTelegramSnake, SNAKE_HTML } from "./snake.ts";

// Runner types predate Bot API 10.4; raw requests accept the new update names.
export const TELEGRAM_UPDATES = [
  "message",
  "callback_query",
  "widget_query",
  "shared_widget_query",
] as unknown as ("message" | "callback_query")[];

type Entry = { id: number; name: string; score: number };
type State = { widgetId?: string; scores: Entry[] };
/** Minimal Bot API 10.4 query shape until the installed Telegram types include widgets. */
export type SnakeQuery = {
  id: string;
  from: User;
  type: { type: string };
  data: string;
  widget_id?: string;
};

/** Create a persistent shared Snake; serialize changes to avoid losing simultaneous scores. */
export function createTelegramSnake(directory: string, api: TelegramApi) {
  const file = resolvePath("telegram-snake.json", directory);
  let queue: Promise<unknown> = Promise.resolve();
  let lastPublished = 0;
  let published: string;
  const serial = <T>(work: () => Promise<T>): Promise<T> => {
    const next = queue.catch(() => {}).then(work);
    queue = next;
    return next;
  };
  async function load(): Promise<State> {
    try {
      const state = await Bun.file(file).json();
      if (
        (state.widgetId !== undefined && typeof state.widgetId !== "string") ||
        !Array.isArray(state.scores) ||
        state.scores.length > 10 ||
        !state.scores.every(
          (entry: Entry) =>
            Number.isSafeInteger(entry.id) &&
            typeof entry.name === "string" &&
            [...entry.name].length <= 12 &&
            Number.isInteger(entry.score) &&
            entry.score >= 0 &&
            entry.score <= 193,
        )
      )
        throw new Error("Invalid Snake leaderboard storage");
      return state;
    } catch (error) {
      if (error.code === "ENOENT") return { scores: [] };
      throw error;
    }
  }
  async function save(state: State) {
    await Bun.write(`${file}.tmp`, JSON.stringify(state));
    await rename(`${file}.tmp`, file);
  }
  const publicData = (state: State) =>
    JSON.stringify(state.scores.map(({ name, score }) => [name, score]));

  /** Send the original shared widget once, then reuse its saved identifier across messages. */
  function send(payload: Record<string, unknown>) {
    return serial(async () => {
      const state = await load();
      if (state.widgetId) return api("sendSharedWidget", { ...payload, widget_id: state.widgetId });
      const sent = await api("sendWidget", {
        ...payload,
        html: SNAKE_HTML,
        is_shared: true,
        allow_queries: true,
        public_data: publicData(state),
      });
      const id = sent?.widget?.id;
      if (typeof id !== "string" || !id) throw new Error("Telegram returned no shared widget id");
      state.widgetId = id;
      await save(state);
      return sent;
    });
  }

  return {
    /** Consume only Snake commands, retaining the shared command's private-chat checks. */
    handleMessage: (message: Parameters<typeof handleTelegramSnake>[0], username: string) =>
      handleTelegramSnake(message, username, api, send),
    /** Validate submitted scores and Telegram identity, persist personal bests, then publish the top ten. */
    handleQuery(query: SnakeQuery) {
      return serial(async () => {
        const state = await load();
        if (!state.widgetId || query.widget_id !== state.widgetId) return;
        const match =
          typeof query.data === "string" && query.data.match(/^snake:score:(0|[1-9]\d{0,2})$/u);
        let error: string;
        if (
          query.type?.type !== "data" ||
          !Number.isSafeInteger(query.from?.id) ||
          query.from.is_bot ||
          (query.data !== "snake:top" && (!match || Number(match[1]) > 193))
        ) {
          error = "Некорректный результат";
        } else if (match) {
          const score = Number(match[1]);
          const previous = state.scores.find((entry) => entry.id === query.from.id);
          // shortcut: scores come from the client; replay games server-side if competitive prizes are added.
          if (!previous || score > previous.score) {
            const name = [...(query.from.first_name || "Игрок").replace(/[\p{C}\p{Z}]/gu, " ")]
              .slice(0, 12)
              .join("");
            state.scores = [
              ...state.scores.filter((entry) => entry.id !== query.from.id),
              { id: query.from.id, name, score },
            ]
              .sort((a, b) => b.score - a.score || a.id - b.id)
              .slice(0, 10);
            await save(state);
          }
        }
        const current = publicData(state);
        if (!error && current !== published) {
          const wait = 1100 - (Date.now() - lastPublished);
          if (wait > 0) await Bun.sleep(wait);
          lastPublished = Date.now();
          await api("editSharedWidgetData", {
            widget_id: state.widgetId,
            public_data: current,
            cache_time: 5,
          });
          published = current;
        }
        await api("answerWidgetQuery", {
          widget_query_id: query.id,
          data: JSON.stringify({ top: JSON.parse(current), error }),
        });
      }).catch(async (error) => {
        console.warn("Telegram Snake leaderboard failed:", String(error));
        await api("answerWidgetQuery", {
          widget_query_id: query.id,
          data: JSON.stringify({ error: "Не удалось обновить рейтинг. Попробуйте ещё раз." }),
        }).catch(() => {});
      });
    },
  };
}
