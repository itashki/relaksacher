/** @file Shared injected telegram test setup; each call owns its dependency state. */
import type { TestSessionOptions } from "./fixtures.ts";
import type { AppConfig } from "../../src/types.ts";
import { createTelegramBot } from "./fixtures.ts";

export type TelegramPayload = {
  text?: string;
  chat_id?: number;
  message_id?: number;
  callback_query_id?: string;
  reply_markup?: { inline_keyboard: { callback_data?: string }[][] };
  document?: Blob;
  disable_web_page_preview?: boolean;
  reply_parameters?: { message_id?: number };
  [key: string]: unknown;
};

/**
 * Build an injected Telegram adapter with no external network requests.
 * @param run Custom fake session execution.
 * @param config Telegram adapter settings.
 * @returns Bot fixture, API calls and captured session options.
 */
export function setup(
  run?: (
    options: TestSessionOptions,
    instance: ReturnType<typeof createTelegramBot>,
  ) => Promise<unknown>,
  config: Partial<AppConfig> = { telegramUpdateIntervalMs: 0 },
) {
  const calls: { method: string; payload?: TelegramPayload }[] = [];
  const inputs: TestSessionOptions[] = [];
  const bot = createTelegramBot({
    config,
    api: async (method, payload: TelegramPayload = {}) => {
      calls.push({ method, payload });
      if (method === "getMe") return { id: 99, username: "testbot", is_bot: true };
      if (method === "getChatMember") return { status: "member" };
      return { message_id: calls.length, text: payload.text };
    },
    assistant: {
      createSession(options) {
        inputs.push(options);
        return {
          stop() {
            calls.push({ method: "stopped" });
          },
          async run() {
            if (run) return run(options, bot);
            await options.onUpdate({ text: "", modelAlias: "терн", final: false });
            await options.onUpdate({ text: "answer", modelAlias: "терн", final: true });
            return { text: "answer", thinkingLog: "" };
          },
        };
      },
    },
  });
  return { bot, calls, inputs };
}
/**
 * Build a minimal user-authored Telegram message for adapter tests.
 * @param id Message identifier.
 * @param text Text or undefined for image-only fixtures.
 * @param chat Chat metadata.
 * @returns Message fixture.
 */
export const message = (
  id: number,
  text: string,
  chat: { id: number; type: "private" | "group" | "supergroup" } = { id: 1, type: "private" },
) => ({
  message_id: id,
  text,
  chat,
  from: { id: 10, first_name: "Alice" },
});
