/** @file Operator pause skips model inference, delivers a notice and resumes normally. */
import { expect, test } from "bun:test";
import { setup } from "../support/assistant-fixture.ts";
import { createAssistantBridge } from "../../src/core/assistant-bridge.ts";

test("paused requests deliver a final notice without inference and resume after replacement", async () => {
  const first = setup([]);
  const bridge = createAssistantBridge(first.assistant);
  bridge.assistant.setRepliesPaused(true);
  const result = await bridge.assistant.createSession(first.options).run();
  expect(result.text).toBe("Ответы ИИ временно отключены.");
  expect(first.requests).toHaveLength(0);
  expect(first.updates).toEqual([{ text: result.text, status: "", final: true }]);
  const next = setup([[{ message: { content: "hello again" } }]]);
  bridge.replace(next.assistant);
  expect(bridge.assistant.repliesPaused()).toBe(true);
  await bridge.assistant.createSession(next.options).run();
  expect(next.requests).toHaveLength(0);
  bridge.assistant.setRepliesPaused(false);
  expect((await bridge.assistant.createSession(next.options).run()).text).toBe("hello again");
  expect(next.requests).toHaveLength(1);
  bridge.close();
});
