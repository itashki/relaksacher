/** @file Regression coverage for cli behavior and its external boundaries. */
import { expect, test } from "bun:test";
import { createCliControls } from "../support/fixtures.ts";

test("CLI handles streamed commands, CRLF and a final line without a newline", async () => {
  const input = new TransformStream<Uint8Array, Uint8Array>();
  const source = input.writable.getWriter();
  let text = "";
  let calls = 0;
  const controls = createCliControls({
    input: input.readable,
    output: {
      write(value: string) {
        text += value;
        return value.length;
      },
    },
    assistant: {
      stopCurrentGeneration() {
        return ++calls === 1;
      },
    },
  });
  const encoder = new TextEncoder();
  for (const part of [" ST", "OP \r", "\nstop\nhelp\nunknown\n\n", "stop"])
    await source.write(encoder.encode(part));
  await source.close();
  if ("done" in controls) await controls.done;
  expect(calls).toBe(3);
  expect(text).toMatch(/Остановка генерации запрошена/);
  expect(text).toMatch(/Нет активной генерации/);
  expect(text).toMatch(/Неизвестная команда/);
  expect(text.match(/CLI:/g)?.length).toBe(2);
  controls.close();
});

test("closing CLI cancels input and ignores unfinished commands", async () => {
  let cancelled = false;
  let source: ReadableStreamDefaultController<Uint8Array>;
  const input = new ReadableStream<Uint8Array>({
    start(controller) {
      source = controller;
    },
    cancel() {
      cancelled = true;
    },
  });
  let calls = 0;
  const controls = createCliControls({
    input,
    output: {
      write() {
        return 0;
      },
    },
    assistant: {
      stopCurrentGeneration() {
        calls++;
        return true;
      },
    },
  });
  source.enqueue(new TextEncoder().encode("sto"));
  controls.close();
  controls.close();
  if ("done" in controls) await controls.done;
  expect(cancelled).toBe(true);
  expect(calls).toBe(0);
});

test("CLI restart leaves input responsive, coalesces repeats, and reports build failures", async () => {
  const input = new TransformStream<Uint8Array, Uint8Array>();
  const writer = input.writable.getWriter();
  let text = "",
    calls = 0;
  const pending = Promise.withResolvers<void>();
  const controls = createCliControls({
    input: input.readable,
    output: {
      write(value: string) {
        text += value;
        return value.length;
      },
    },
    assistant: { stopCurrentGeneration: () => false },
    onRestart: () => {
      calls++;
      return pending.promise;
    },
  });
  try {
    await writer.write(new TextEncoder().encode("restart\nrestart\nhelp\n"));
    await Bun.sleep(0);
    expect(calls).toBe(1);
    expect(text.match(/CLI:/g)).toHaveLength(2);
    pending.reject(new Error("broken build"));
    await Bun.sleep(0);
    expect(text).toContain("broken build");
    await writer.close();
    if ("done" in controls) await controls.done;
  } finally {
    controls.close();
  }
});
