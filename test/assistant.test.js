/** @file Regression tests for assistant.test. */
import test from "node:test";
import assert from "node:assert/strict";
import { createAssistant } from "../src/core/assistant.js";
import { createToolService } from "../src/core/tools.js";

/**
 * Create fake model streams and capture requests and updates.
 * @param {Array<Array<Partial<import("ollama").ChatResponse>>>} rounds Model chunks by round.
 * @param {Partial<import("../src/types.js").AssistantOptions>} [overrides] Dependency overrides.
 * @returns {object} Assistant fixture and captured events.
 */
function setup(rounds, overrides = {}) {
  const requests = [];
  const updates = [];
  let aborted = 0;
  const memory = {
    loadMemory: async () => [{ id: 1, fact: "shared fact" }],
    buildMemoryPrompt: (facts, enabled) => enabled ? facts.map((f) => f.fact).join("\n") : "",
    addMemoryFact: async () => "saved",
    removeMemoryFact: async () => "removed",
  };
  const modelClient = { async chat(request) {
    requests.push(structuredClone(request));
    const parts = rounds.shift();
    return {
      abort() { aborted++; },
      async *[Symbol.asyncIterator]() {
        yield* parts;
        if (!parts.some((part) => part.done)) yield { done: true, done_reason: "stop", message: {} };
      },
    };
  }};
  const assistant = createAssistant({ modelClient, memory,
    toolService: createToolService({ memory, fallbackClient: null }), model: "test", numCtx: 16384,
    timeoutMs: 1000, updateIntervalMs: 0, ...overrides });
  return { assistant, requests, updates, memory, get aborted() { return aborted; },
    options: { conversation: [{ role: "user", content: "hello" }], onUpdate: (state) => updates.push(state) } };
}

test("streams plain snapshots and carries memory/tools into the next model round", async () => {
  const call = { function: { name: "remember", arguments: { fact: "new fact" } } };
  const env = setup([
    [{ message: { thinking: "considering", tool_calls: [call] } }],
    [{ message: { thinking: "done thinking" } }, { message: { content: "answer" } }],
  ]);
  const result = await env.assistant.createSession({ ...env.options,
    context: { scopeId: "123", authorName: "Alice" }, think: true,
    platformInstructions: "CLI conversation",
  }).run();
  assert.equal(result.text, "answer");
  assert.equal(result.thinkingLog, "considering\n\n---\n\ndone thinking");
  assert.match(env.requests[0].messages[0].content, /shared fact/);
  assert.match(env.requests[0].messages[0].content, /CLI conversation/);
  assert.equal(env.requests[0].think, true);
  assert.deepEqual(env.requests[0].tools.map((tool) => tool.function.name), ["remember", "forget"]);
  assert.equal(env.requests[1].messages.at(-1).content, "saved");
  assert.ok(env.updates.some((state) => state.status === call));
  assert.equal(env.updates.at(-1).final, true);
  assert.equal(env.updates.at(-1).liveThinking, undefined);
  assert.equal(env.aborted, 1);
});

test("unscoped requests have no memory tools and disabled search is reported", async () => {
  const env = setup([[{ message: { content: "answer" } }]]);
  const result = await env.assistant.createSession({ ...env.options, search: true }).run();
  assert.deepEqual(env.requests[0].tools.map((t) => t.function.name), ["enable_thinking"]);
  assert.doesNotMatch(env.requests[0].messages[0].content, /shared fact|Discord/);
  assert.match(result.text, /Поиск недоступен/);
});

test("stop before running avoids a model request and finalizes the session", async () => {
  const env = setup([]);
  const session = env.assistant.createSession(env.options);
  session.stop();
  const result = await session.run();
  assert.equal(env.requests.length, 0);
  assert.equal(result.stopped, true);
  assert.equal(env.updates.at(-1).final, true);
  await assert.rejects(session.run(), /already started/);
});

test("stop while awaiting the stream aborts it before consuming output", async () => {
  let session;
  let aborted = false;
  const env = setup([], { modelClient: { async chat() {
    session.stop();
    return { abort() { aborted = true; }, async *[Symbol.asyncIterator]() { throw new Error("should not read"); } };
  } } });
  session = env.assistant.createSession(env.options);
  const result = await session.run();
  assert.equal(aborted, true);
  assert.equal(result.stopped, true);
  assert.equal(result.failed, false);
});

test("timeout aborts a live stream and reports timeout", async () => {
  const env = setup([], { timeoutMs: 5, modelClient: { async chat() {
    let finish;
    const waiting = new Promise((resolve) => { finish = resolve; });
    return { abort() { finish(); }, async *[Symbol.asyncIterator]() { await waiting; } };
  } } });
  const result = await env.assistant.createSession(env.options).run();
  assert.equal(result.timedOut, true);
  assert.equal(result.failed, false);
  assert.match(result.text, /Превышено время/);
});

test("tool rounds are bounded and the final model request disables tools", async () => {
  const call = { function: { name: "remember", arguments: { fact: "fact" } } };
  const env = setup(Array.from({ length: 6 }, () => [{ message: { tool_calls: [call] } }]));
  await env.assistant.createSession({ ...env.options, context: { scopeId: "123" } }).run();
  assert.equal(env.requests.length, 6);
  assert.equal(env.requests.at(-1).tools, undefined);
});

test("model errors preserve partial output and finalize with an error", async (t) => {
  t.mock.method(console, "error", () => {});
  const env = setup([], { modelClient: { async chat() {
    return { abort() {}, async *[Symbol.asyncIterator]() {
      yield { message: { content: "partial" } };
      throw new Error("connection lost");
    }};
  } } });
  const result = await env.assistant.createSession(env.options).run();
  assert.equal(result.failed, true);
  assert.match(result.text, /^partial\n\n⚠️/);
  assert.equal(env.updates.at(-1).final, true);
});

test("web search fetches top results and falls back to snippets for failed pages", async () => {
  const fetched = [];
  const service = createToolService({ memory: {}, searchClient: {
    async webSearch({ max_results }) {
      assert.equal(max_results, 8);
      return { results: [
        { title: "first", url: "https://first.example", content: "snippet one" },
        { title: "second", url: "https://second.example", content: "snippet two" },
        { title: "third", url: "https://third.example", content: "snippet three" },
      ] };
    },
    async webFetch({ url }) {
      fetched.push(url);
      if (url.includes("second")) throw new Error("unavailable");
      return { content: "full page" };
    },
  } });
  assert.equal(service.definitions({ search: false }).length, 0);
  assert.deepEqual(service.definitions({ search: true }).map((tool) => tool.function.name), ["web_search", "web_fetch"]);
  const result = JSON.parse(await service.runTool({ function: {
    name: "web_search", arguments: { query: "question", max_results: 99 },
  } }));
  assert.equal(fetched.length, 2);
  assert.deepEqual(result.map((item) => item.content), ["full page", "snippet two", "snippet three"]);
});

test("uses the same configured model across sessions and tool rounds", async () => {
  const call = { function: { name: "remember", arguments: { fact: "fact" } } };
  const env = setup([
    [{ message: { tool_calls: [call] } }],
    [{ message: { content: "answer" } }],
    [{ message: { content: "next answer" } }],
  ], { model: "fixed-model", numCtx: 32768 });
  await env.assistant.createSession({ ...env.options, context: { scopeId: "123" } }).run();
  const next = await env.assistant.createSession(env.options).run();
  assert.deepEqual(env.requests.map((r) => r.model), ["fixed-model", "fixed-model", "fixed-model"]);
  assert.deepEqual(env.requests.map((r) => r.options.num_ctx), [32768, 32768, 32768]);
  assert.equal(next.modelAlias, undefined);
  assert.equal(env.updates.at(-1).modelAlias, undefined);
  assert.equal(next.text, "next answer");
});

test("background stays separate from the dialogue and the current request stays last", async () => {
  const env = setup([[{ message: { content: "answer" } }]]);
  const background = [{ id: "10", author: "Bob", content: "question for Alice /search" }];
  await env.assistant.createSession({ ...env.options, background }).run();
  const { messages, tools } = env.requests[0];
  assert.equal(messages[1].role, "user");
  assert.match(messages[1].content, /Фоновый контекст канала/);
  assert.match(messages[1].content, /question for Alice/);
  assert.deepEqual(messages.at(-1), { role: "user", content: "hello" });
  assert.deepEqual(tools.map((t) => t.function.name), ["enable_thinking"]);
});

test("model can enable thinking in response to a natural-language request", async () => {
  const env = setup([
    [{ message: { tool_calls: [{ function: { name: "enable_thinking", arguments: {} } }] } }],
    [{ message: { thinking: "checking carefully", content: "answer" } }],
  ]);
  await env.assistant.createSession({ ...env.options,
    conversation: [{ role: "user", content: "Подумай хорошенько перед ответом" }],
  }).run();
  assert.deepEqual(env.requests.map((r) => r.think), [false, true]);
  assert.ok(env.requests[0].tools.some((t) => t.function.name === "enable_thinking"));
  assert.ok(!env.requests[1].tools?.some((t) => t.function.name === "enable_thinking"));
  assert.match(env.requests[1].messages.at(-1).content, /включён/);
});

test("search tools are available automatically and may be explicitly disabled", async () => {
  const toolService = {
    searchEnabled: true,
    definitions: ({ search }) => search ? [{ type: "function", function: { name: "web_search" } }] : [],
  };
  const env = setup([
    [{ message: { content: "answer" } }], [{ message: { content: "offline answer" } }],
  ], { toolService });
  await env.assistant.createSession(env.options).run();
  await env.assistant.createSession({ ...env.options, search: false }).run();
  assert.ok(env.requests[0].tools.some((t) => t.function.name === "web_search"));
  assert.ok(!env.requests[1].tools.some((t) => t.function.name === "web_search"));
});

test("generation limit is marked in the final text and snapshot", async () => {
  const env = setup([[{ message: { content: "unfinished" } },
    { done: true, done_reason: "length", message: {} }]]);
  const result = await env.assistant.createSession(env.options).run();
  assert.equal(result.incompleteReason, "length");
  assert.match(result.text, /^unfinished\n\n⚠️ Ответ не завершён: достигнут лимит генерации/);
  assert.equal(env.updates.at(-1).text, result.text);
});

test("a stream without a terminal done event is marked as interrupted", async () => {
  const env = setup([], { modelClient: { async chat() {
    return { abort() {}, async *[Symbol.asyncIterator]() { yield { message: { content: "partial" } }; } };
  } } });
  const result = await env.assistant.createSession(env.options).run();
  assert.equal(result.incompleteReason, "stream_interrupted");
  assert.match(result.text, /⚠️ Ответ не завершён/);
});

test("normal completion has no incomplete marker", async () => {
  const env = setup([[{ message: { content: "complete answer" } }]]);
  const result = await env.assistant.createSession(env.options).run();
  assert.equal(result.incompleteReason, null);
  assert.equal(result.text, "complete answer");
});

test("assistant sessions share a queue and waiting does not start a model request", async () => {
  let release;
  let started;
  const ready = new Promise((resolve) => { started = resolve; });
  const gate = new Promise((resolve) => { release = resolve; });
  let calls = 0;
  const env = setup([], { modelClient: { async chat() {
    const first = ++calls === 1;
    started();
    return { abort() {}, async *[Symbol.asyncIterator]() {
      if (first) await gate;
      yield { message: { content: "answer" } };
      yield { done: true, done_reason: "stop", message: {} };
    } };
  } } });
  const first = env.assistant.createSession(env.options).run();
  await ready;
  let position;
  const second = env.assistant.createSession({ ...env.options, onQueued: async (value) => { position = value; } }).run();
  await Promise.resolve();
  assert.equal(position, 1);
  assert.equal(calls, 1);
  release();
  await Promise.all([first, second]);
  assert.equal(calls, 2);
});

test("oversized required context is reported without starting model generation", async () => {
  const env = setup([], { numCtx: 1024 });
  const result = await env.assistant.createSession(env.options).run();
  assert.equal(env.requests.length, 0);
  assert.equal(result.incompleteReason, "context_limit");
  assert.match(result.text, /контекст слишком велики/);
});

test("owner facts reach the system prompt independently of shared memory", async () => {
  const env = setup([[{ message: { content: "answer" } }]], { facts: ["Game night is Friday."] });
  await env.assistant.createSession(env.options).run();
  const system = env.requests[0].messages[0].content;
  assert.match(system, /Game night is Friday\./);
  assert.match(system, /Не перечисляй их без повода/);
  assert.equal(env.requests[0].messages.at(-1).content, "hello");
});

test("thinking is logged server-side and never included in streamed updates", async () => {
  const logs = [];
  const env = setup([[{ message: { thinking: "private reasoning" } }, { message: { content: "answer" } }]], {
    logger: { info: (...args) => logs.push(args) },
  });
  await env.assistant.createSession(env.options).run();
  assert.equal(logs.length, 1);
  assert.equal(logs[0][0], "[thinking]");
  assert.equal(logs[0][1].text, "private reasoning");
  assert.ok(env.updates.every((state) => !JSON.stringify(state).includes("private reasoning")));
});

test("personality is injected into the system prompt independently of platform", async () => {
  const env = setup([[{ message: { content: "answer" } }]], { personality: "Custom local personality" });
  await env.assistant.createSession(env.options).run();
  assert.match(env.requests[0].messages[0].content, /Custom local personality/);
});

test("supervisor chooses thinking before the main round and explicit think bypasses it", async () => {
  let routed = 0;
  const env = setup([[{ message: { content: "answer" } }], [{ message: { content: "second" } }]], {
    logger: { info() {} }, supervisor: { async decideThinking() { routed++; return true; } },
  });
  await env.assistant.createSession(env.options).run();
  await env.assistant.createSession({ ...env.options, think: true }).run();
  assert.equal(routed, 1);
  assert.ok(env.requests.every((request) => request.think));
  assert.ok(!env.requests[0].tools?.some((tool) => tool.function.name === "enable_thinking"));
  env.assistant.stopObserving();
});

test("ordinary messages are batched by group/room and saved with source attribution", async () => {
  const extracted = [];
  const saved = [];
  const env = setup([], { logger: { info() {} },
    memory: { async addMemoryFact(...args) { saved.push(args); } },
    supervisor: { async extractFacts(messages) {
      extracted.push(messages);
      return [{ text: messages[0].text, authorName: messages[0].authorName }];
    } },
  });
  env.assistant.observeMessage({ scopeId: "telegram_-1", roomId: "topic-1", id: "10", text: "Release day is Friday", authorName: "Alice" });
  env.assistant.observeMessage({ scopeId: "telegram_-2", roomId: "topic-1", id: "11", text: "Other group", authorName: "Bob" });
  env.assistant.observeMessage({ roomId: "private", id: "12", text: "private info", authorName: "Carol" });
  assert.equal(extracted.length, 0);
  await env.assistant.flushObservations();
  assert.deepEqual(saved[0], ["telegram_-1", "Release day is Friday", "Alice"]);
  await env.assistant.flushObservations();
  assert.equal(extracted[1][0].text, "Other group");
  assert.equal(extracted.length, 2);
  env.assistant.stopObserving();
});

test("automatic saves are limited to one per group per cooldown across all rooms", async (t) => {
  let now = 100000;
  t.mock.method(Date, "now", () => now);
  let checks = 0;
  const saved = [];
  const env = setup([], { logger: { info() {} },
    memory: { async addMemoryFact(...args) { saved.push(args); } },
    supervisor: { async extractFacts() { checks++; return [{ text: "fact", authorName: "Alice" }]; } },
  });
  const observe = (scopeId = "group", roomId = "room") => env.assistant.observeMessage({ scopeId, roomId, id: String(now), text: "Our project releases Friday", authorName: "Alice" });
  observe();
  await env.assistant.flushObservations();
  now += 61000;
  observe("group", "another-room");
  await env.assistant.flushObservations();
  assert.equal(checks, 1);
  observe("other-group");
  await env.assistant.flushObservations();
  assert.equal(saved.length, 2);
  now += 59000;
  observe();
  await env.assistant.flushObservations();
  assert.equal(saved.length, 3);
  env.assistant.stopObserving();
});

test("successful media delivery permits an empty final answer without markers", async () => {
  const call = { function: { name: "send_image", arguments: { id: "image_1" } } };
  const env = setup([[{ message: { tool_calls: [call] } }], [{ message: { content: "" } }]], {
    toolService: { searchEnabled: false, definitions: () => [], async runTool(_call, context) {
      context.imageState.sent = true;
      return "Медиа отправлено";
    } },
  });
  const result = await env.assistant.createSession(env.options).run();
  assert.equal(result.text, "");
  assert.equal(result.incompleteReason, null);
  assert.equal(env.updates.at(-1).text, "");
  assert.equal(env.updates.at(-1).final, true);
});
