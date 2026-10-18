import { expect, test } from "bun:test";
import { guardContext, ContextLimitError } from "../src/core/context.ts";

test("drops background first, preserves recent dialogue and complete tool rounds", () => {
  const current = { role: "user", content: "current request" };
  const toolCall = { role: "assistant", content: "", tool_calls: [{ function: { name: "web_search" } }] };
  const result = { role: "tool", content: "search result" };
  const messages = [
    { role: "system", content: "rules" },
    { role: "user", content: "background".repeat(3000) },
    { role: "user", content: "older question" },
    { role: "assistant", content: "older answer" },
    current, toolCall, result,
  ];
  expect(guardContext(messages, [], 2048).trimmed).toBe(true);
  expect(messages[1].content).toBe("older question");
  expect(messages.slice(-3)).toStrictEqual([current, toolCall, result]);
  expect(messages[0].content).toMatch(/Часть старой истории удалена/);
});

test("oversized current request fails rather than silently discarding it", () => {
  const current = { role: "user", content: "x".repeat(20000) };
  const messages = [{ role: "system", content: "rules" }, current];
  expect(() => guardContext(messages, [], 2048)).toThrow(ContextLimitError);
  expect(messages[1]).toBe(current);
});

test("old user/assistant turns are removed together and schemas count toward budget", () => {
  const messages = [{ role: "system", content: "rules" },
    { role: "user", content: "x".repeat(5000) }, { role: "assistant", content: "old answer" },
    { role: "user", content: "current" }];
  guardContext(messages, [], 2048);
  expect(messages.slice(1)).toStrictEqual([{ role: "user", content: "current" }]);
  expect(() => guardContext(messages, [{ type: "function", function: {name: "large", description: "x".repeat(20000)} }], 2048)).toThrow(ContextLimitError);
});
