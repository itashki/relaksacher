/** @file Restart a real generation queue through Telegram without truncating or dropping requests. */
import { expect, test } from "bun:test";
import { createRestartController, createRestartRouter } from "../../src/core/restart.ts";
import { setup as assistantSetup } from "../support/assistant-fixture.ts";
import { createTelegramBot } from "../support/fixtures.ts";
import { message, type TelegramPayload } from "../support/telegram-fixture.ts";

test("restart retains batching, running and queued generations, and waits for the final chat edit", async () => {
  const started = Promise.withResolvers<void>();
  const finishStream = Promise.withResolvers<void>();
  const finalEdit = Promise.withResolvers<void>();
  const finishEdit = Promise.withResolvers<void>();
  const paused = Promise.withResolvers<void>();
  const replies: string[] = [];
  let stopCalls = 0,
    modelCalls = 0,
    replacements = 0,
    nextMessageId = 100;
  const oldAssistant = assistantSetup([], {
    timeoutMs: 5000,
    modelClient: {
      async chat() {
        const call = ++modelCalls;
        return {
          abort() {},
          async *[Symbol.asyncIterator]() {
            yield { message: { content: `old-${call}` } };
            if (call === 1) {
              started.resolve();
              await finishStream.promise;
            }
            yield { done: true, done_reason: "stop", message: { content: " complete" } };
          },
        };
      },
    },
  }).assistant;
  const oldBot = createTelegramBot({
    config: { messageBatchWindowMs: 10, telegramUpdateIntervalMs: 0 },
    assistant: {
      ...oldAssistant,
      createSession(options) {
        const session = oldAssistant.createSession(options);
        return {
          ...session,
          stop() {
            stopCalls++;
            session.stop();
          },
        };
      },
    },
    api: async (method, payload: TelegramPayload = {}) => {
      if (method === "getMe") return { id: 99, username: "testbot" };
      if (payload.text) replies.push(payload.text);
      if (method === "editMessageText" && payload.text === "old-1 complete") {
        finalEdit.resolve();
        await finishEdit.promise;
      }
      return { message_id: ++nextMessageId, text: payload.text };
    },
  });
  const received: number[] = [];
  let handler = oldBot.handleUpdate;
  const router = createRestartRouter<Parameters<typeof handler>[0]>((update) => handler(update));
  const restart = createRestartController({
    prepare: async () => {},
    router: {
      ...router,
      pause() {
        router.pause();
        paused.resolve();
      },
    },
    replace: async () => {
      await oldBot.stop();
      oldAssistant.stopObserving();
      replacements++;
      handler = async (update) => {
        received.push(update.message.message_id);
      };
    },
  });
  const active = router.dispatch({ message: message(1, "first") });
  await started.promise;
  // This burst has not left the adapter's debounce window when restart is requested.
  const queued = router.dispatch({ message: message(2, "second") });
  const done = restart.restart();
  await paused.promise;
  const buffered = [3, 4].map((id) => router.dispatch({ message: message(id, "incoming") }));
  finishStream.resolve();
  await finalEdit.promise;
  expect(replacements).toBe(0);
  expect(stopCalls).toBe(0);
  finishEdit.resolve();
  await Promise.all([active, queued, done, ...buffered]);
  expect(modelCalls).toBe(2);
  expect(replies).toContain("old-1 complete");
  expect(replies).toContain("old-2 complete");
  expect(replies.some((text) => text.includes("остановлена"))).toBe(false);
  expect(stopCalls).toBe(0);
  expect(received).toEqual([3, 4]);
  expect(replacements).toBe(1);
});
