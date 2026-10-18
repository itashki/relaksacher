import test from "node:test";
import assert from "node:assert/strict";
import { createToolService } from "../src/core/tools.js";

test("history is offered only when a scoped reader exists and limits result size", async () => {
  const service = createToolService({ memory: {} });
  assert.ok(!service.definitions({}).some((tool) => tool.function.name === "read_history"));
  assert.ok(service.definitions({ history: true }).some((tool) => tool.function.name === "read_history"));
  let requested;
  const output = JSON.parse(await service.runTool({ function: { name: "read_history", arguments: { limit: 999 } } }, {
    readHistory: async (limit) => {
      requested = limit;
      return { source: "test", messages: Array.from({ length: 25 }, (_, i) => ({ id: String(i), content: "x".repeat(2000) })) };
    },
  }));
  assert.equal(requested, 20);
  assert.equal(output.messages.length, 20);
  assert.ok(output.messages.every((message) => message.content.length <= 801));
  assert.match(await service.runTool({ function: { name: "read_history", arguments: {} } }, {}), /недоступно/);
});
