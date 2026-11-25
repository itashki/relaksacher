/** @file Regression coverage for context behavior and its external boundaries. */
import { expect, test } from "bun:test";
import { guardContext } from "../../src/core/assistant/context.ts";

test("drops background first, preserves recent dialogue and complete tool rounds", () => {
  const current = { role: "user", content: "current request" };
  const toolCall = {
    role: "assistant",
    content: "",
    tool_calls: [{ function: { name: "web_search" } }],
  };
  const result = { role: "tool", content: "search result" };
  const messages = [
    { role: "system", content: "rules" },
    { role: "user", content: "background".repeat(3000) },
    { role: "user", content: "older question" },
    { role: "assistant", content: "older answer" },
    current,
    toolCall,
    result,
  ];
  expect(guardContext(messages, [], 2048).trimmed).toBe(true);
  expect(messages[1].content).toBe("older question");
  expect(messages.slice(-3)).toStrictEqual([current, toolCall, result]);
  expect(messages[0].content).toMatch(/Часть старой истории удалена/);
});

test("huge current tool result is truncated, not rejected", () => {
  const messages = [
    { role: "system", content: "rules" },
    { role: "user", content: "current" },
    { role: "assistant", content: "" },
    { role: "tool", content: "я".repeat(20000) },
  ];
  guardContext(messages, [], 2048);
  expect(messages[1].content).toBe("current");
  expect(messages[3].content).toMatch(/^я+\nРезультат обрезан из-за размера контекста\.$/);
  expect(messages[3].content.length).toBeLessThan(3000);
});

test("huge current user text is truncated, not rejected", () => {
  const messages = [
    { role: "system", content: "rules" },
    { role: "user", content: "x".repeat(20000) },
  ];
  guardContext(messages, [], 2048);
  expect(messages[1].content).toMatch(/^x+\nРезультат обрезан из-за размера контекста\.$/);
  expect(messages[1].content.length).toBeLessThan(3000);
});

test("old user/assistant turns are removed together and schemas count toward budget", () => {
  const messages = [
    { role: "system", content: "rules" },
    { role: "user", content: "x".repeat(5000) },
    { role: "assistant", content: "old answer" },
    { role: "user", content: "current" },
  ];
  guardContext(messages, [], 2048);
  expect(messages.slice(1)).toStrictEqual([{ role: "user", content: "current" }]);
  guardContext(
    messages,
    [{ type: "function", function: { name: "large", description: "x".repeat(20000) } }],
    2048,
  );
  expect(messages[1].content).toMatch(/Результат обрезан/);
});

test("token estimate is calibrated to characters/2.5, not UTF-8 bytes", () => {
  // 4000 Cyrillic chars ~ 1600 tokens (bytes/3 would say ~2700): fits a 4096 window (budget 3072).
  const messages = [
    { role: "system", content: "rules" },
    { role: "user", content: "old" },
    { role: "assistant", content: "ok" },
    { role: "user", content: "я".repeat(4000) },
  ];
  expect(guardContext(messages, [], 4096).trimmed).toBe(false);
  // ~3600 tokens by the calibrated estimate exceeds the same budget.
  messages[3].content = "я".repeat(9000);
  expect(guardContext(messages, [], 4096).trimmed).toBe(true);
});
