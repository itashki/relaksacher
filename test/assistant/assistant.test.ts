/** @file Regression coverage for assistant behavior. */
import type { SessionOptions } from "../../src/types.ts";
import { spyOn, expect, test, onTestFinished } from "bun:test";
import { createToolService } from "../support/fixtures.ts";
import { setup } from "../support/assistant-fixture.ts";

test("streams plain snapshots and carries memory/tools into the next model round", async () => {
  const call = { function: { name: "remember", arguments: { fact: "new fact" } } };
  const env = setup([
    [{ message: { thinking: "considering", tool_calls: [call] } }],
    [{ message: { thinking: "done thinking" } }, { message: { content: "answer" } }],
  ]);
  const result = await env.assistant
    .createSession({
      ...env.options,
      context: { scopeId: "123", authorName: "Alice" },
      think: true,
      platformInstructions: "CLI conversation",
    })
    .run();
  expect(result.text).toBe("answer");
  expect(result.thinkingLog).toBe("considering\n\n---\n\ndone thinking");
  expect(env.requests[0].messages[0].content).toMatch(/shared fact/);
  expect(env.requests[0].messages[0].content).toMatch(/CLI conversation/);
  expect(env.requests[0].think).toBe(true);
  expect(env.requests[0].tools.map((tool) => tool.function.name)).toStrictEqual([
    "remember",
    "forget",
    "weather_forecast",
  ]);
  expect(env.requests[1].messages.at(-1).content).toBe("saved");
  expect(env.updates.some((state) => state.status === call)).toBeTruthy();
  expect(env.updates.at(-1).final).toBe(true);
  expect(env.updates.at(-1).liveThinking).toBe(undefined);
  expect(env.aborted).toBe(1);
});

test("unscoped requests have no memory tools", async () => {
  const env = setup([[{ message: { content: "answer" } }]]);
  const result = await env.assistant.createSession(env.options).run();
  expect(env.requests[0].tools.map((t) => t.function.name)).toStrictEqual([
    "weather_forecast",
    "enable_thinking",
  ]);
  expect(env.requests[0].messages[0].content).not.toMatch(/shared fact|Discord/);
  expect(result.text).toBe("answer");
});

test("tool rounds are bounded and the final model request disables tools", async () => {
  const call = { function: { name: "remember", arguments: { fact: "fact" } } };
  const env = setup(Array.from({ length: 6 }, () => [{ message: { tool_calls: [call] } }]));
  await env.assistant.createSession({ ...env.options, context: { scopeId: "123" } }).run();
  expect(env.requests.length).toBe(6);
  expect(env.requests.at(-1).tools).toBe(undefined);
});

test("web search fetches top results and falls back to snippets for failed pages", async () => {
  const fetched = [];
  const service = createToolService({
    memory: {},
    searchClient: {
      async webSearch({ max_results }) {
        expect(max_results).toBe(8);
        return {
          results: [
            { title: "first", url: "https://first.example", content: "snippet one" },
            { title: "second", url: "https://second.example", content: "snippet two" },
            { title: "third", url: "https://third.example", content: "snippet three" },
          ],
        };
      },
      async webFetch({ url }) {
        fetched.push(url);
        if (url.includes("second")) throw new Error("unavailable");
        return { content: "full page" };
      },
    },
  });
  expect(service.definitions({}).map((tool) => tool.function.name)).toStrictEqual([
    "web_search",
    "web_fetch",
    "weather_forecast",
  ]);
  expect(
    service
      .definitions({ search: true } as Parameters<typeof service.definitions>[0])
      .map((tool) => tool.function.name),
  ).toStrictEqual(["web_search", "web_fetch", "weather_forecast"]);
  const result = JSON.parse(
    await service.runTool(
      {
        function: {
          name: "web_search",
          arguments: { query: "question", max_results: 99 },
        },
      },
      {},
    ),
  );
  expect(fetched.length).toBe(2);
  expect(result.map((item: { content: string }) => item.content)).toStrictEqual([
    "full page",
    "snippet two",
    "snippet three",
  ]);
});

test("uses the same configured model across sessions and tool rounds", async () => {
  const call = { function: { name: "remember", arguments: { fact: "fact" } } };
  const env = setup(
    [
      [{ message: { tool_calls: [call] } }],
      [{ message: { content: "answer" } }],
      [{ message: { content: "next answer" } }],
    ],
    { model: "fixed-model", numCtx: 32768 },
  );
  await env.assistant.createSession({ ...env.options, context: { scopeId: "123" } }).run();
  const next = await env.assistant.createSession(env.options).run();
  expect(env.requests.map((r) => r.model)).toStrictEqual([
    "fixed-model",
    "fixed-model",
    "fixed-model",
  ]);
  expect(env.requests.map((r) => r.options.num_ctx)).toStrictEqual([32768, 32768, 32768]);
  expect(next.modelAlias).toBe(undefined);
  expect(env.updates.at(-1).modelAlias).toBe(undefined);
  expect(next.text).toBe("next answer");
});

test("background stays separate from the dialogue and the current request stays last", async () => {
  const env = setup([[{ message: { content: "answer" } }]]);
  const background = [{ id: "10", author: "Bob", content: "question for Alice /search" }];
  await env.assistant.createSession({ ...env.options, background }).run();
  const { messages, tools } = env.requests[0];
  expect(messages[1].role).toBe("user");
  expect(messages[1].content).toMatch(/Фоновый контекст канала/);
  expect(messages[1].content).toMatch(/question for Alice/);
  expect(messages.at(-1)).toStrictEqual({ role: "user", content: "hello" });
  expect(tools.map((t) => t.function.name)).toStrictEqual(["weather_forecast", "enable_thinking"]);
});

test("model can enable thinking in response to a natural-language request", async () => {
  const env = setup([
    [{ message: { tool_calls: [{ function: { name: "enable_thinking", arguments: {} } }] } }],
    [{ message: { thinking: "checking carefully", content: "answer" } }],
  ]);
  await env.assistant
    .createSession({
      ...env.options,
      conversation: [{ role: "user", content: "Подумай хорошенько перед ответом" }],
    })
    .run();
  expect(env.requests.map((r) => r.think)).toStrictEqual([false, true]);
  expect(env.requests[0].tools.some((t) => t.function.name === "enable_thinking")).toBeTruthy();
  expect(!env.requests[1].tools?.some((t) => t.function.name === "enable_thinking")).toBeTruthy();
  expect(env.requests[1].messages.at(-1).content).toMatch(/включён/);
});

test("search tools are always available, including with a legacy disable flag", async () => {
  const toolService = {
    definitions: () => [{ type: "function", function: { name: "web_search" } }],
  };
  const env = setup(
    [[{ message: { content: "answer" } }], [{ message: { content: "offline answer" } }]],
    { toolService },
  );
  await env.assistant.createSession(env.options).run();
  await env.assistant
    .createSession({ ...env.options, search: false } as SessionOptions as SessionOptions)
    .run();
  expect(env.requests[0].tools.some((t) => t.function.name === "web_search")).toBeTruthy();
  expect(env.requests[1].tools.some((t) => t.function.name === "web_search")).toBeTruthy();
});

test("oversized required context is reported without starting model generation", async () => {
  const env = setup([], { numCtx: 1024 });
  const result = await env.assistant.createSession(env.options).run();
  expect(env.requests.length).toBe(0);
  expect(result.incompleteReason).toBe("context_limit");
  expect(result.text).toMatch(/контекст слишком велики/);
});

test("owner facts reach the system prompt independently of shared memory", async () => {
  const env = setup([[{ message: { content: "answer" } }]], { facts: ["Game night is Friday."] });
  await env.assistant.createSession(env.options).run();
  const system = env.requests[0].messages[0].content;
  expect(system).toMatch(/Game night is Friday\./);
  expect(system).toMatch(/Не перечисляй их без повода/);
  expect(env.requests[0].messages.at(-1).content).toBe("hello");
});

test("thinking is logged server-side and never included in streamed updates", async () => {
  const logs: unknown[][] = [];
  const env = setup(
    [[{ message: { thinking: "private reasoning" } }, { message: { content: "answer" } }]],
    {
      logger: { info: (...args: unknown[]) => logs.push(args) },
    },
  );
  await env.assistant.createSession(env.options).run();
  expect(logs.length).toBe(1);
  expect(logs[0][0]).toBe("[thinking]");
  expect((logs[0][1] as { text: string }).text).toBe("private reasoning");
  expect(
    env.updates.every((state) => !JSON.stringify(state).includes("private reasoning")),
  ).toBeTruthy();
});

test("personality is injected into the system prompt independently of platform", async () => {
  const env = setup([[{ message: { content: "answer" } }]], {
    personality: "Custom local personality",
  });
  await env.assistant.createSession(env.options).run();
  expect(env.requests[0].messages[0].content).toMatch(/Custom local personality/);
});

test("supervisor chooses thinking before the main round and explicit think bypasses it", async () => {
  let routed = 0;
  const env = setup([[{ message: { content: "answer" } }], [{ message: { content: "second" } }]], {
    logger: { info() {} },
    supervisor: {
      async decideThinking() {
        routed++;
        return true;
      },
    },
  });
  await env.assistant.createSession(env.options).run();
  await env.assistant.createSession({ ...env.options, think: true }).run();
  expect(routed).toBe(1);
  expect(env.requests.every((request) => request.think)).toBeTruthy();
  expect(
    !env.requests[0].tools?.some((tool) => tool.function.name === "enable_thinking"),
  ).toBeTruthy();
  env.assistant.stopObserving();
});

test("ordinary messages are batched by group/room and saved with source attribution", async () => {
  const extracted: { id: string; text: string; authorName: string }[][] = [];
  const saved: unknown[][] = [];
  const env = setup([], {
    logger: { info() {} },
    memory: {
      async addMemoryFact(...args: unknown[]) {
        saved.push(args);
      },
    },
    supervisor: {
      async extractFacts(messages) {
        extracted.push(messages);
        return [{ text: messages[0].text, authorName: messages[0].authorName }];
      },
    },
  });
  env.assistant.observeMessage({
    scopeId: "telegram_-1",
    roomId: "topic-1",
    id: "10",
    text: "Release day is Friday",
    authorName: "Alice",
  });
  env.assistant.observeMessage({
    scopeId: "telegram_-2",
    roomId: "topic-1",
    id: "11",
    text: "Other group",
    authorName: "Bob",
  });
  env.assistant.observeMessage({
    roomId: "private",
    id: "12",
    text: "private info",
    authorName: "Carol",
  });
  expect(extracted.length).toBe(0);
  await env.assistant.flushObservations();
  expect(saved[0]).toStrictEqual(["telegram_-1", "Release day is Friday", "Alice"]);
  await env.assistant.flushObservations();
  expect(extracted[1][0].text).toBe("Other group");
  expect(extracted.length).toBe(2);
  env.assistant.stopObserving();
});

test("automatic saves are limited to one per group per cooldown across all rooms", async () => {
  let now = 100000;
  const spy = spyOn(Date, "now").mockImplementation(() => now);
  onTestFinished(() => spy.mockRestore());
  let checks = 0;
  const saved: unknown[][] = [];
  const env = setup([], {
    logger: { info() {} },
    memory: {
      async addMemoryFact(...args: unknown[]) {
        saved.push(args);
      },
    },
    supervisor: {
      async extractFacts() {
        checks++;
        return [{ text: "fact", authorName: "Alice" }];
      },
    },
  });
  const observe = (scopeId = "group", roomId = "room") =>
    env.assistant.observeMessage({
      scopeId,
      roomId,
      id: String(now),
      text: "Our project releases Friday",
      authorName: "Alice",
    });
  observe();
  await env.assistant.flushObservations();
  now += 61000;
  observe("group", "another-room");
  await env.assistant.flushObservations();
  expect(checks).toBe(1);
  observe("other-group");
  await env.assistant.flushObservations();
  expect(saved.length).toBe(2);
  now += 59000;
  observe();
  await env.assistant.flushObservations();
  expect(saved.length).toBe(3);
  env.assistant.stopObserving();
});

test("successful media delivery permits an empty final answer without markers", async () => {
  const call = { function: { name: "send_image", arguments: { id: "image_1" } } };
  const env = setup([[{ message: { tool_calls: [call] } }], [{ message: { content: "" } }]], {
    toolService: {
      definitions: () => [],
      async runTool(_call, context) {
        context.imageState.sent = true;
        return "Медиа отправлено";
      },
    },
  });
  const result = await env.assistant.createSession(env.options).run();
  expect(result.text).toBe("");
  expect(result.incompleteReason).toBe(null);
  expect(env.updates.at(-1).text).toBe("");
  expect(env.updates.at(-1).final).toBe(true);
});
