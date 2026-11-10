/** @file Operator pause skips model inference, delivers a notice and resumes normally. */
import { expect, test } from "bun:test";
import { setup } from "../support/assistant-fixture.ts";

test("paused requests deliver a final notice without inference and resume normally", async () => {
  const first = setup([[{ message: { content: "hello again" } }]]);
  first.assistant.setRepliesPaused(true);
  const result = await first.assistant.createSession(first.options).run();
  expect(result.text).toBe("Ответы ИИ временно отключены.");
  expect(first.requests).toHaveLength(0);
  expect(first.updates).toEqual([{ text: result.text, status: "", final: true }]);
  first.assistant.setRepliesPaused(false);
  expect((await first.assistant.createSession(first.options).run()).text).toBe("hello again");
  expect(first.requests).toHaveLength(1);
});
