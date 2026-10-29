/** @file Verify per-session vision routing and safe compatibility with non-thinking models. */
import { expect, test } from "bun:test";
import type { ChatRequest } from "ollama";
import type { AssistantOptions, ModelStream } from "../../src/types.ts";
import { createModelChat } from "../../src/core/assistant/models.ts";
import { fixture } from "../support/fixtures.ts";
import { setup } from "../support/assistant-fixture.ts";

test("images in a reply chain select the vision model for all tool rounds and reported results", async () => {
  const env = setup(
    [
      [{ message: { tool_calls: [{ function: { name: "read_history", arguments: {} } }] } }],
      [{ message: { content: "image answer" } }],
      [{ message: { content: "text answer" } }],
    ],
    { model: "text-model", visionModel: "vision-model" },
  );
  const result = await env.assistant
    .createSession({
      ...env.options,
      conversation: [
        { role: "user", content: "look at this", images: ["base64-image"] },
        { role: "assistant", content: "what would you like to know?" },
        { role: "user", content: "describe its colors" },
      ],
      context: { readHistory: async () => ({ source: "test", messages: [] }) },
    })
    .run();
  expect(env.requests.slice(0, 2).map((request) => request.model)).toEqual([
    "vision-model",
    "vision-model",
  ]);
  expect(env.requests[1].messages[1].images).toEqual(["base64-image"]);
  expect(result.model).toBe("vision-model");
  expect(result.failed).toBe(false);
  const text = await env.assistant.createSession(env.options).run();
  expect(env.requests[2].model).toBe("text-model");
  expect(text.model).toBe("text-model");
});

test("without a separate vision model image requests retain the configured main model", async () => {
  const env = setup([[{ message: { content: "answer" } }]]);
  await env.assistant
    .createSession({
      ...env.options,
      conversation: [{ role: "user", content: "describe", images: ["image"] }],
    })
    .run();
  expect(env.requests[0].model).toBe("test");
});

test("unsupported native thinking retries once, retains tools/images and is cached per model", async () => {
  const requests: ChatRequest[] = [];
  const stream: ModelStream = {
    abort() {},
    async *[Symbol.asyncIterator]() {},
  };
  const client = fixture<AssistantOptions["modelClient"]>({
    async chat(request) {
      requests.push(request);
      if (request.model === "text" && request.think !== undefined)
        throw Object.assign(new Error('"text" does not support thinking'), { status_code: 400 });
      return stream;
    },
  });
  const chat = createModelChat(client);
  const request = {
    model: "text",
    stream: true as const,
    think: true,
    messages: [{ role: "user", content: "question", images: ["image"] }],
    tools: [
      {
        type: "function",
        function: { name: "read_history", parameters: { type: "object", properties: {} } },
      },
    ],
  };
  expect(await chat(request)).toBe(stream);
  expect(requests.map((request) => request.think)).toEqual([true, undefined]);
  expect(requests[1].tools).toBe(request.tools);
  expect(requests[1].messages).toBe(request.messages);
  await chat(request);
  expect(requests.length).toBe(3);
  expect(requests[2].think).toBeUndefined();
  await chat({ ...request, model: "vision" });
  expect(requests[3].think).toBe(true);
});

test("tool incompatibility and server errors propagate without retry or dropping tool schemas", async () => {
  for (const error of [
    Object.assign(new Error("model does not support tools"), { status_code: 400 }),
    Object.assign(new Error("server unavailable"), { status_code: 503 }),
  ]) {
    let calls = 0;
    const chat = createModelChat(
      fixture<AssistantOptions["modelClient"]>({
        async chat() {
          calls++;
          throw error;
        },
      }),
    );
    await expect(chat({ model: "text", stream: true, think: true, messages: [] })).rejects.toBe(
      error,
    );
    expect(calls).toBe(1);
  }
});
