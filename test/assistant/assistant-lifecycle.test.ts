/** @file Regression coverage for assistant lifecycle behavior. */
import type { ChatResponse } from "ollama";
import type { Session, TerminalState } from "../../src/types.ts";
import { spyOn, expect, test, onTestFinished } from "bun:test";
import { setup } from "../support/assistant-fixture.ts";

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
