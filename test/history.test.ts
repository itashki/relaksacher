import { expect, test } from "bun:test";
import { createToolService } from "./fixtures.ts";

test("history is offered only when a scoped reader exists and limits result size", async () => {
  const service = createToolService({ memory: {} });
  expect(!service.definitions({}).some((tool) => tool.function.name === "read_history")).toBeTruthy();
  expect(service.definitions({ history: true }).some((tool) => tool.function.name === "read_history")).toBeTruthy();
  let requested: number | undefined;
  const output = JSON.parse(await service.runTool({ function: { name: "read_history", arguments: { limit: 999 } } }, {
    readHistory: async (limit) => {
      requested = limit;
      return { source: "test", messages: Array.from({ length: 25 }, (_, i) => ({ id: String(i), author: "Alice", content: "x".repeat(2000) })) };
    },
  }));
  expect(requested).toBe(20);
  expect(output.messages.length).toBe(20);
  expect(output.messages.every((message: {content: string}) => message.content.length <= 801)).toBeTruthy();
  expect(await service.runTool({ function: { name: "read_history", arguments: {} } }, {})).toMatch(/недоступно/);
});
