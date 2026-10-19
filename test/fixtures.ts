/** @file Typed partial doubles and injected factories used only at external test boundaries. */
import type { HttpFetch, SessionOptions, GenerationUpdate } from "../src/types.ts";
import { createImageSearch as imageSearch } from "../src/core/image-search.ts";
import { createAssistant as assistant } from "../src/core/assistant.ts";
import { createToolService as tools } from "../src/core/tools.ts";
import { createDiscordBot as discord } from "../src/adapters/discord.ts";
import {
  createTelegramBot as telegram,
  createTelegramApi as telegramApi,
} from "../src/adapters/telegram.ts";
import { createSupervisor as supervisor } from "../src/core/supervisor.ts";
import { createCliControls as cli } from "../src/adapters/cli.ts";
import { createTui as tui } from "../src/adapters/tui.ts";

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
export const createDiscordBot = factory(discord);
export function createTelegramBot(options: Fixture<Parameters<typeof telegram>[0]>) {
  const bot = telegram(fixture<Parameters<typeof telegram>[0]>(options));
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
