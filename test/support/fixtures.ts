/** @file Typed partial doubles and injected factories used only at external test boundaries. */
import type { HttpFetch, SessionOptions, GenerationUpdate } from "../../src/types.ts";
import { createImageSearch as imageSearch } from "../../src/core/tools/image-search.ts";
import { createAssistant as assistant } from "../../src/core/assistant/index.ts";
import { createToolService as tools } from "../../src/core/tools/index.ts";
import { createDiscordBot as discord } from "../../src/adapters/discord/index.ts";
import {
  createTelegramBot as telegram,
  createTelegramApi as telegramApi,
} from "../../src/adapters/telegram/index.ts";
import { createSupervisor as supervisor } from "../../src/core/assistant/supervisor.ts";
import { createCliControls as cli } from "../../src/adapters/terminal/cli.ts";
import { createTui as tui } from "../../src/adapters/terminal/tui.ts";

/** Test doubles implement only the members exercised by a particular test. */
export type Fixture<T> = T extends (...args: infer Args) => unknown
  ? (
      ...args: { [K in keyof Args]: Args[K] extends SessionOptions ? TestSessionOptions : Args[K] }
    ) => unknown
  : T extends readonly (infer Item)[]
    ? Fixture<Item>[]
    : T extends object
      ? { [Key in keyof T]?: Fixture<T[Key]> }
      : T;

/** Keep the assertion at the boundary between partial doubles and production APIs. */
export function fixture<T>(value: Fixture<T>): T {
  return value as T;
}

function factory<Options, Result>(create: (options: Options) => Result) {
  return (options: Fixture<Options>): Result => create(fixture<Options>(options));
}
export const createAssistant = factory(assistant);
export const createToolService = factory(tools);
export function createDiscordBot(options: Fixture<Parameters<typeof discord>[0]>) {
  return discord(
    fixture<Parameters<typeof discord>[0]>({
      ...options,
      config: { messageBatchWindowMs: 0, ...options.config },
    }),
  );
}
export function createTelegramBot(options: Fixture<Parameters<typeof telegram>[0]>) {
  const bot = telegram(
    fixture<Parameters<typeof telegram>[0]>({
      ...options,
      config: { messageBatchWindowMs: 0, ...options.config },
    }),
  );
  return {
    ...bot,
    handleUpdate: (update: Fixture<import("@grammyjs/types").Update>) =>
      bot.handleUpdate(fixture<import("@grammyjs/types").Update>(update)),
  };
}
export const createSupervisor = factory(supervisor);
export const createCliControls = factory(cli);
export const createTui = factory(tui);

export type TestUpdate = Partial<GenerationUpdate> & {
  thinkingLog?: string;
  liveThinking?: string;
};
export type TestSessionOptions = Omit<SessionOptions, "onUpdate"> & {
  onUpdate: (update: TestUpdate) => void | Promise<void>;
  // Tests assert that adapters never pass the removed search toggle.
  search?: boolean;
};

export type FetchStub = (url: RequestInfo | URL, init?: RequestInit) => Promise<Fixture<Response>>;
export function createTelegramApi(
  token: string,
  fetchImpl?: FetchStub,
  options?: Parameters<typeof telegramApi>[2],
) {
  return telegramApi(token, fetchImpl as HttpFetch, options);
}

type ImageSearchClient = NonNullable<Parameters<typeof imageSearch>[0]>;
export function createImageSearch(
  search?: (
    ...args: Parameters<ImageSearchClient>
  ) => Promise<Fixture<Awaited<ReturnType<ImageSearchClient>>>>,
  getText?: Parameters<typeof imageSearch>[1],
) {
  return imageSearch(search as Parameters<typeof imageSearch>[0], getText);
}
