import { expect, test } from "bun:test";
import { createSupervisor } from "./fixtures.ts";

function fixture(result: unknown) {
  const calls: import("ollama").ChatRequest[] = [];
  const supervisor = createSupervisor({ modelClient: { async chat(request) {
    calls.push(request);
    return { abort() {}, async *[Symbol.asyncIterator]() {
      yield { message: { content: JSON.stringify(result) } };
      yield { done: true, done_reason: "stop" };
    } };
  } } });
  return { supervisor, calls };
}

test("router uses the small non-thinking model and validates its boolean decision", async () => {
  const { supervisor, calls } = fixture({ think: true });
  expect(await supervisor.decideThinking([{ role: "user", content: "solve a complex problem" }])).toBe(true);
  expect(calls[0].model).toBe("qwen3:0.6b");
  expect(calls[0].think).toBe(false);
  expect(calls[0].options.num_ctx).toBe(2048);
  await expect(fixture({ think: "yes" }).supervisor.decideThinking([])).rejects.toThrow(/Invalid/);
});

test("fact extraction rejects low confidence, unknown sources and sensitive values", async () => {
  const { supervisor } = fixture({ facts: [
    { text: "Release day is Friday", confidence: 0.99, messageId: "1", category: "recurring_schedule" },
    { text: "Uncertain", confidence: 0.5, messageId: "1" },
    { text: "Unknown source", confidence: 0.99, messageId: "other" },
  ] });
  expect(await supervisor.extractFacts([{ id: "1", text: "Release day is Friday", authorName: "Alice" }])).toStrictEqual([{ text: "Release day is Friday", authorName: "Alice" }]);
  const sensitive = fixture({ facts: [{ text: "Email is alice@example.org", confidence: 1, messageId: "1" }] });
  expect(await sensitive.supervisor.extractFacts([{ id: "1", text: "email", authorName: "Alice" }])).toStrictEqual([]);
});

test("supervisor times out even while waiting for model loading", async () => {
  let resolveChat: (stream: {abort(): void; [Symbol.asyncIterator](): AsyncGenerator<never>}) => void;
  let aborted = false;
  const supervisor = createSupervisor({ timeoutMs: 5, modelClient: { chat: () => new Promise<{abort(): void; [Symbol.asyncIterator](): AsyncGenerator<never>}>((resolve) => { resolveChat = resolve; }) } });
  await expect(supervisor.decideThinking([])).rejects.toThrow(/timed out/);
  resolveChat({ abort() { aborted = true; }, async *[Symbol.asyncIterator]() {} });
  await Promise.resolve();
  expect(aborted).toBe(true);
});

test("spontaneous classification needs both a clear angle and high confidence", async () => {
  const input = { text: "a light-hearted joke", authorName: "Alice" };
  expect(await fixture({ reply: true, confidence: 0.99, angle: "a witty observation" }).supervisor.decideReply(input)).toStrictEqual({ angle: "a witty observation" });
  expect(await fixture({ reply: true, confidence: 0.6, angle: "maybe" }).supervisor.decideReply(input)).toBe(null);
  expect(await fixture({ reply: false, confidence: 1, angle: "" }).supervisor.decideReply(input)).toBe(null);
});

test("extractor never receives author metadata and rejects names as facts", async () => {
  const { supervisor, calls } = fixture({ facts: [{ text: "Держите меня семеро", confidence: 1, messageId: "1" }] });
  const facts = await supervisor.extractFacts([{ id: "1", text: "Our project releases are on Friday", authorName: "Держите меня семеро (username: test, id: 123)" }]);
  expect(facts).toStrictEqual([]);
  expect(calls[0].messages.at(-1).content).not.toMatch(/Держите меня семеро|authorName/);
});

test("empty messages cannot be sources and do not trigger extraction", async () => {
  const { supervisor, calls } = fixture({ facts: [] });
  expect(await supervisor.extractFacts([{ id: "1", text: "   ", authorName: "Alice" }])).toStrictEqual([]);
  expect(calls.length).toBe(0);
});

test("casual reactions do not trigger automatic memory extraction", async () => {
  const { supervisor, calls } = fixture({ facts: [{ text: "Рекомендации сразу с крупного калибра начали", confidence: 1, messageId: "1", category: "project_fact" }] });
  expect(await supervisor.extractFacts([{ id: "1", text: "Рекомендации сразу с крупного калибра начали", authorName: "Alice" }])).toStrictEqual([]);
  expect(calls.length).toBe(0);
});

test("auto-memory rejects invented details and saves at most one verbatim fact per batch", async () => {
  const source = [{ id: "1", text: "Our project releases are every Friday.", authorName: "Alice" }];
  const invented = fixture({ facts: [{ text: "Our project releases started in 2023.", confidence: 1, messageId: "1", category: "project_fact" }] });
  expect(await invented.supervisor.extractFacts(source)).toStrictEqual([]);
  const multiple = fixture({ facts: [
    { text: source[0].text, confidence: 1, messageId: "1", category: "recurring_schedule" },
    { text: "every Friday", confidence: 1, messageId: "1", category: "recurring_schedule" },
  ] });
  expect(await multiple.supervisor.extractFacts(source)).toStrictEqual([{ text: source[0].text, authorName: "Alice" }]);
});
