/** @file Regression coverage for assistant behavior and its external boundaries. */
import type { ChatRequest, ChatResponse, Message } from "ollama";
import type {
  AssistantOptions,
  SessionOptions,
  Session,
  MemoryStore,
  GenerationUpdate,
  TerminalState,
} from "../src/types.ts";
import type { Fixture } from "./fixtures.ts";
import { spyOn, expect, test, onTestFinished } from "bun:test";
import { createAssistant } from "./fixtures.ts";
import { createToolService } from "./fixtures.ts";

/**
 * Create fake model streams and capture requests and updates.
 * @param rounds Model chunks by round.
 * @param overrides Dependency overrides.
 * @returns Assistant fixture and captured events.
 */
function setup(
  rounds: (Omit<Partial<ChatResponse>, "message"> & { message?: Partial<Message> })[][],
  overrides: Fixture<AssistantOptions> = {},
) {
  const requests: ChatRequest[] = [];
  const updates: (GenerationUpdate & { liveThinking?: string })[] = [];
  let aborted = 0;
  const memory: MemoryStore = {
    loadMemory: async () => [{ id: 1, fact: "shared fact" }],
    buildMemoryPrompt: (facts, enabled) => (enabled ? facts.map((f) => f.fact).join("\n") : ""),
    addMemoryFact: async () => "saved",
    removeMemoryFact: async () => "removed",
  };
  const modelClient = {
    async chat(request: ChatRequest) {
      requests.push(structuredClone(request));
      const parts = rounds.shift();
      return {
        abort() {
          aborted++;
        },
        async *[Symbol.asyncIterator]() {
          yield* parts;
          if (!parts.some((part) => part.done))
            yield { done: true, done_reason: "stop", message: {} };
        },
      };
    },
  };
  const assistant = createAssistant({
    modelClient,
    memory,
    toolService: createToolService({ memory, fallbackClient: null }),
    model: "test",
    numCtx: 16384,
    timeoutMs: 1000,
    updateIntervalMs: 0,
    ...overrides,
  });
  return {
    assistant,
    requests,
    updates,
    memory,
    get aborted() {
      return aborted;
    },
    options: {
      conversation: [{ role: "user", content: "hello" }],
      onUpdate: (state: GenerationUpdate) => {
        updates.push(state);
      },
    },
  };
}

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
  expect(env.requests[0].tools.map((t) => t.function.name)).toStrictEqual(["enable_thinking"]);
  expect(env.requests[0].messages[0].content).not.toMatch(/shared fact|Discord/);
  expect(result.text).toBe("answer");
});

test("stop before running avoids a model request and finalizes the session", async () => {
  const env = setup([]);
  const session = env.assistant.createSession(env.options);
  session.stop();
  const result = await session.run();
  expect(env.requests.length).toBe(0);
  expect(result.stopped).toBe(true);
  expect(env.updates.at(-1).final).toBe(true);
  await expect(session.run()).rejects.toThrow(/already started/);
});

test("stop while awaiting the stream aborts it before consuming output", async () => {
  let session: Session;
  let aborted = false;
  const env = setup([], {
    modelClient: {
      async chat() {
        session.stop();
        return {
          abort() {
            aborted = true;
          },
          [Symbol.asyncIterator]() {
            return {
              async next() {
                throw new Error("should not read");
              },
            };
          },
        };
      },
    },
  });
  session = env.assistant.createSession(env.options);
  const result = await session.run();
  expect(aborted).toBe(true);
  expect(result.stopped).toBe(true);
  expect(result.failed).toBe(false);
});

test("timeout aborts a live stream and reports timeout", async () => {
  const env = setup([], {
    timeoutMs: 5,
    modelClient: {
      async chat() {
        let finish: () => void;
        const waiting = new Promise<void>((resolve) => {
          finish = resolve;
        });
        return {
          abort() {
            finish();
          },
          [Symbol.asyncIterator]() {
            return {
              async next(): Promise<IteratorResult<ChatResponse, undefined>> {
                await waiting;
                return { done: true as const, value: undefined };
              },
            };
          },
        };
      },
    },
  });
  const result = await env.assistant.createSession(env.options).run();
  expect(result.timedOut).toBe(true);
  expect(result.failed).toBe(false);
  expect(result.text).toMatch(/Превышено время/);
});

test("tool rounds are bounded and the final model request disables tools", async () => {
  const call = { function: { name: "remember", arguments: { fact: "fact" } } };
  const env = setup(Array.from({ length: 6 }, () => [{ message: { tool_calls: [call] } }]));
  await env.assistant.createSession({ ...env.options, context: { scopeId: "123" } }).run();
  expect(env.requests.length).toBe(6);
  expect(env.requests.at(-1).tools).toBe(undefined);
});

test("model errors preserve partial output and finalize with an error", async () => {
  const spy = spyOn(console, "error").mockImplementation(() => {});
  onTestFinished(() => spy.mockRestore());
  const env = setup([], {
    modelClient: {
      async chat() {
        return {
          abort() {},
          async *[Symbol.asyncIterator]() {
            yield { message: { content: "partial" } };
            throw new Error("connection lost");
          },
        };
      },
    },
  });
  const result = await env.assistant.createSession(env.options).run();
  expect(result.failed).toBe(true);
  expect(result.text).toMatch(/^partial\n\n⚠️/);
  expect(env.updates.at(-1).final).toBe(true);
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
  ]);
  expect(
    service
      .definitions({ search: true } as Parameters<typeof service.definitions>[0])
      .map((tool) => tool.function.name),
  ).toStrictEqual(["web_search", "web_fetch"]);
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
  expect(tools.map((t) => t.function.name)).toStrictEqual(["enable_thinking"]);
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
    searchEnabled: true,
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

test("generation limit is marked in the final text and snapshot", async () => {
  const env = setup([
    [{ message: { content: "unfinished" } }, { done: true, done_reason: "length", message: {} }],
  ]);
  const result = await env.assistant.createSession(env.options).run();
  expect(result.incompleteReason).toBe("length");
  expect(result.text).toMatch(/^unfinished\n\n⚠️ Ответ не завершён: достигнут лимит генерации/);
  expect(env.updates.at(-1).text).toBe(result.text);
});

test("a stream without a terminal done event is marked as interrupted", async () => {
  const env = setup([], {
    modelClient: {
      async chat() {
        return {
          abort() {},
          async *[Symbol.asyncIterator]() {
            yield { message: { content: "partial" } };
          },
        };
      },
    },
  });
  const result = await env.assistant.createSession(env.options).run();
  expect(result.incompleteReason).toBe("stream_interrupted");
  expect(result.text).toMatch(/⚠️ Ответ не завершён/);
});

test("normal completion has no incomplete marker", async () => {
  const env = setup([[{ message: { content: "complete answer" } }]]);
  const result = await env.assistant.createSession(env.options).run();
  expect(result.incompleteReason).toBe(null);
  expect(result.text).toBe("complete answer");
});

test("assistant sessions share a queue and waiting does not start a model request", async () => {
  let release: () => void;
  let started: () => void;
  const ready = new Promise<void>((resolve) => {
    started = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let calls = 0;
  const env = setup([], {
    modelClient: {
      async chat() {
        const first = ++calls === 1;
        started();
        return {
          abort() {},
          async *[Symbol.asyncIterator]() {
            if (first) await gate;
            yield { message: { content: "answer" } };
            yield { done: true, done_reason: "stop", message: {} };
          },
        };
      },
    },
  });
  const first = env.assistant.createSession(env.options).run();
  await ready;
  let position: number | undefined;
  const second = env.assistant
    .createSession({
      ...env.options,
      onQueued: async (value) => {
        position = value;
      },
    })
    .run();
  await Promise.resolve();
  expect(position).toBe(1);
  expect(calls).toBe(1);
  release();
  await Promise.all([first, second]);
  expect(calls).toBe(2);
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
      searchEnabled: false,
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

test("operator cancellation stops only the active reply and preserves queued work", async () => {
  let ready: () => void;
  const started = new Promise<void>((resolve) => {
    ready = resolve;
  });
  let calls = 0;
  const env = setup([], {
    modelClient: {
      async chat() {
        const first = ++calls === 1;
        let release: () => void;
        const gate = new Promise<void>((resolve) => {
          release = resolve;
        });
        return {
          abort() {
            release();
          },
          async *[Symbol.asyncIterator]() {
            if (first) {
              ready();
              await gate;
            }
            yield { message: { content: "answer" } };
            yield { done: true, done_reason: "stop", message: {} };
          },
        };
      },
    },
  });
  expect(env.assistant.stopCurrentGeneration()).toBe(false);
  const first = env.assistant.createSession(env.options).run();
  await started;
  const second = env.assistant.createSession(env.options).run();
  expect(env.assistant.stopCurrentGeneration()).toBe(true);
  expect(env.assistant.stopCurrentGeneration()).toBe(false);
  expect((await first).stopped).toBe(true);
  expect((await second).text).toBe("answer");
  expect(calls).toBe(2);
  expect(env.assistant.stopCurrentGeneration()).toBe(false);
});

test("active generation is cleared even if final delivery fails", async () => {
  const env = setup([[{ message: { content: "answer" } }]]);
  await expect(
    env.assistant
      .createSession({
        ...env.options,
        onUpdate(state) {
          if (state.final) throw new Error("delivery failed");
        },
      })
      .run(),
  ).rejects.toThrow(/delivery failed/);
  expect(env.assistant.stopCurrentGeneration()).toBe(false);
});

test("terminal receives live reasoning and queued requests without exposing thoughts to adapters", async () => {
  let release: () => void;
  let ready: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const started = new Promise<void>((resolve) => {
    ready = resolve;
  });
  let calls = 0;
  const env = setup([], {
    logger: { info() {} },
    modelClient: {
      async chat() {
        const first = ++calls === 1;
        return {
          abort() {
            release();
          },
          async *[Symbol.asyncIterator]() {
            if (first) {
              yield { message: { thinking: "local thoughts" } };
              ready();
              await gate;
            }
            yield { message: { content: "answer" } };
            yield { done: true, done_reason: "stop", message: {} };
          },
        };
      },
    },
  });
  const snapshots: TerminalState[] = [];
  const unsubscribe = env.assistant.subscribeTerminal((state) => snapshots.push(state));
  const first = env.assistant
    .createSession({ ...env.options, context: { authorName: "Alice" } })
    .run();
  await started;
  const second = env.assistant
    .createSession({ ...env.options, context: { authorName: "Bob" } })
    .run();
  const queued = snapshots.at(-1);
  expect(queued.current.author).toBe("Alice");
  expect(queued.current.thinking).toBe("local thoughts");
  expect(queued.queue[0].author).toBe("Bob");
  // Subscribers cannot mutate live state.
  queued.current.thinking = "changed";
  release();
  await Promise.all([first, second]);
  expect(snapshots.some((state) => state.last?.thinking === "local thoughts")).toBeTruthy();
  expect(snapshots.at(-1).current).toBe(null);
  expect(snapshots.at(-1).queue).toStrictEqual([]);
  expect(
    env.updates.every((state) => !JSON.stringify(state).includes("local thoughts")),
  ).toBeTruthy();
  unsubscribe();
});

test("repeated thinking retries once with thinking and tools disabled", async () => {
  const env = setup(
    [
      [{ message: { thinking: "Проверю результат ещё раз. ".repeat(5) } }],
      [{ message: { content: "Краткий ответ" } }],
    ],
    { logger: { info() {} } },
  );
  const result = await env.assistant.createSession({ ...env.options, think: true }).run();
  expect(env.requests.map((request) => request.think)).toEqual([true, false]);
  expect(env.requests[1].tools).toBeUndefined();
  expect(result.text).toBe("Краткий ответ");
  expect(result.incompleteReason).toBeNull();
  expect(result.stopped).toBe(false);
});

test("repeated content stops without another generation or tool execution", async () => {
  const env = setup([[{ message: { content: "Повторяющийся ответ. ".repeat(5) } }]]);
  const result = await env.assistant.createSession(env.options).run();
  expect(env.requests.length).toBe(1);
  expect(result.incompleteReason).toBe("repetition");
  expect(result.text).toContain("обнаружено зацикливание");
  expect(result.failed).toBe(false);
  expect(env.updates.at(-1).final).toBe(true);
});

test("a repeated thinking recovery cannot retry indefinitely", async () => {
  const env = setup(
    [
      [{ message: { thinking: "Проверю результат ещё раз. ".repeat(5) } }],
      [{ message: { thinking: "Проверю результат ещё раз. ".repeat(5) } }],
    ],
    { logger: { info() {} } },
  );
  const result = await env.assistant.createSession({ ...env.options, think: true }).run();
  expect(env.requests.length).toBe(2);
  expect(result.incompleteReason).toBe("repetition");
});
