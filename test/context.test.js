import test from "node:test";
import assert from "node:assert/strict";
import { guardContext, ContextLimitError } from "../src/core/context.js";

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
  assert.equal(guardContext(messages, [], 2048).trimmed, true);
  assert.equal(messages[1].content, "older question");
  assert.deepEqual(messages.slice(-3), [current, toolCall, result]);
  assert.match(messages[0].content, /Часть старой истории удалена/);
});

test("oversized current request fails rather than silently discarding it", () => {
  const current = { role: "user", content: "x".repeat(20000) };
  const messages = [{ role: "system", content: "rules" }, current];
  assert.throws(() => guardContext(messages, [], 2048), ContextLimitError);
  assert.equal(messages[1], current);
});

test("old user/assistant turns are removed together and schemas count toward budget", () => {
  const messages = [{ role: "system", content: "rules" },
    { role: "user", content: "x".repeat(5000) }, { role: "assistant", content: "old answer" },
    { role: "user", content: "current" }];
  guardContext(messages, [], 2048);
  assert.deepEqual(messages.slice(1), [{ role: "user", content: "current" }]);
  assert.throws(() => guardContext(messages, [{ schema: "x".repeat(20000) }], 2048), ContextLimitError);
});
