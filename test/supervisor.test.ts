import test from "node:test";
import assert from "node:assert/strict";
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
  assert.equal(await supervisor.decideThinking([{ role: "user", content: "solve a complex problem" }]), true);
  assert.equal(calls[0].model, "qwen3:0.6b");
  assert.equal(calls[0].think, false);
  assert.equal(calls[0].options.num_ctx, 2048);
  await assert.rejects(fixture({ think: "yes" }).supervisor.decideThinking([]), /Invalid/);
});

test("fact extraction rejects low confidence, unknown sources and sensitive values", async () => {
  const { supervisor } = fixture({ facts: [
    { text: "Release day is Friday", confidence: 0.99, messageId: "1", category: "recurring_schedule" },
    { text: "Uncertain", confidence: 0.5, messageId: "1" },
    { text: "Unknown source", confidence: 0.99, messageId: "other" },
  ] });
  assert.deepEqual(await supervisor.extractFacts([{ id: "1", text: "Release day is Friday", authorName: "Alice" }]),
    [{ text: "Release day is Friday", authorName: "Alice" }]);
  const sensitive = fixture({ facts: [{ text: "Email is alice@example.org", confidence: 1, messageId: "1" }] });
  assert.deepEqual(await sensitive.supervisor.extractFacts([{ id: "1", text: "email", authorName: "Alice" }]), []);
});

test("supervisor times out even while waiting for model loading", async () => {
  let resolveChat: (stream: {abort(): void; [Symbol.asyncIterator](): AsyncGenerator<never>}) => void;
  let aborted = false;
  const supervisor = createSupervisor({ timeoutMs: 5, modelClient: { chat: () => new Promise<{abort(): void; [Symbol.asyncIterator](): AsyncGenerator<never>}>((resolve) => { resolveChat = resolve; }) } });
  await assert.rejects(supervisor.decideThinking([]), /timed out/);
  resolveChat({ abort() { aborted = true; }, async *[Symbol.asyncIterator]() {} });
  await Promise.resolve();
  assert.equal(aborted, true);
});

test("spontaneous classification needs both a clear angle and high confidence", async () => {
  const input = { text: "a light-hearted joke", authorName: "Alice" };
  assert.deepEqual(await fixture({ reply: true, confidence: 0.99, angle: "a witty observation" }).supervisor.decideReply(input),
    { angle: "a witty observation" });
  assert.equal(await fixture({ reply: true, confidence: 0.6, angle: "maybe" }).supervisor.decideReply(input), null);
  assert.equal(await fixture({ reply: false, confidence: 1, angle: "" }).supervisor.decideReply(input), null);
});

test("extractor never receives author metadata and rejects names as facts", async () => {
  const { supervisor, calls } = fixture({ facts: [{ text: "Держите меня семеро", confidence: 1, messageId: "1" }] });
  const facts = await supervisor.extractFacts([{ id: "1", text: "Our project releases are on Friday", authorName: "Держите меня семеро (username: test, id: 123)" }]);
  assert.deepEqual(facts, []);
  assert.doesNotMatch(calls[0].messages.at(-1).content, /Держите меня семеро|authorName/);
});

test("empty messages cannot be sources and do not trigger extraction", async () => {
  const { supervisor, calls } = fixture({ facts: [] });
  assert.deepEqual(await supervisor.extractFacts([{ id: "1", text: "   ", authorName: "Alice" }]), []);
  assert.equal(calls.length, 0);
});

test("casual reactions do not trigger automatic memory extraction", async () => {
  const { supervisor, calls } = fixture({ facts: [{ text: "Рекомендации сразу с крупного калибра начали", confidence: 1, messageId: "1", category: "project_fact" }] });
  assert.deepEqual(await supervisor.extractFacts([{ id: "1", text: "Рекомендации сразу с крупного калибра начали", authorName: "Alice" }]), []);
  assert.equal(calls.length, 0);
});

test("auto-memory rejects invented details and saves at most one verbatim fact per batch", async () => {
  const source = [{ id: "1", text: "Our project releases are every Friday.", authorName: "Alice" }];
  const invented = fixture({ facts: [{ text: "Our project releases started in 2023.", confidence: 1, messageId: "1", category: "project_fact" }] });
  assert.deepEqual(await invented.supervisor.extractFacts(source), []);
  const multiple = fixture({ facts: [
    { text: source[0].text, confidence: 1, messageId: "1", category: "recurring_schedule" },
    { text: "every Friday", confidence: 1, messageId: "1", category: "recurring_schedule" },
  ] });
  assert.deepEqual(await multiple.supervisor.extractFacts(source), [{ text: source[0].text, authorName: "Alice" }]);
});
