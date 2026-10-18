import test from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { stripVTControlCharacters } from "node:util";
import { renderDashboard } from "../src/adapters/tui.ts";
import { createTui } from "./fixtures.ts";

test("dashboard fits resized terminals and keeps shortcuts on the last row", () => {
  for (const [columns, rows] of [[100, 30], [40, 18], [20, 8], [2, 2]]) {
    const screen = renderDashboard({ current: null, queue: [] }, { columns, rows, color: true });
    const lines = stripVTControlCharacters(screen).split("\r\n");
    assert.equal(lines.length, rows! - 1);
    assert.ok(lines.every((line) => [...line].length < columns!));
    if (columns! > 20) assert.ok(lines.at(-1)?.includes("Ctrl+C"));
  }
});

test("styled panels strip terminal commands from streamed content", () => {
  const screen = renderDashboard({ current: { id: 1, author: "Alice", scope: "Discord",
    model: "model", status: "Генерация", prompt: "question", thinking: "thought", text: "answer\x1b[2J" },
    queue: [] }, { color: true });
  assert.ok(screen.includes("╭"));
  assert.ok(screen.includes("\x1b[36m"));
  assert.ok(!screen.includes("\x1b[2J"));
  assert.ok(stripVTControlCharacters(screen).includes("answer"));
});

test("dashboard shows current streams and queue and strips terminal commands", () => {
  const screen = renderDashboard({ current: { id: 1, author: "Alice", scope: "Discord",
    model: "model", status: "Генерация", prompt: "question", thinking: "thinking\x1b[2J", text: "answer" },
    queue: [{ id: 2, author: "Bob", prompt: "next" }] });
  for (const value of ["Alice", "thinking", "answer", "Bob", "Очередь: 1"]) assert.ok(screen.includes(value));
  assert.ok(!screen.includes("\x1b"));
});

test("TUI stops generation, captures logs and restores terminal on close", () => {
  const input = new PassThrough() as PassThrough & {setRawMode?: (value: boolean) => void};
  const output = new PassThrough();
  let rendered = "";
  output.on("data", (chunk) => { rendered += chunk; });
  const modes: boolean[] = [];
  input.setRawMode = (value) => modes.push(value);
  let stops = 0;
  let unsubscribed = false;
  const target = { log(..._args: unknown[]) {}, info() {}, warn() {}, error() {}, debug() {} };
  const log = target.log;
  const ui = createTui({ input, output, consoleTarget: target, assistant: {
    subscribeTerminal(listener) {
      listener({ current: null, queue: [] });
      return () => { unsubscribed = true; };
    },
    stopCurrentGeneration() { stops++; return true; },
  } });
  input.emit("keypress", "s", { name: "s" });
  assert.equal(stops, 1);
  target.log("test log");
  ui.close();
  ui.close();
  assert.equal(unsubscribed, true);
  assert.equal(target.log, log);
  assert.deepEqual(modes, [true, false]);
  assert.ok(rendered.includes("\x1b[?1049h"));
  assert.ok(rendered.endsWith("\x1b[?25h\x1b[?1049l"));
  input.emit("keypress", "s", { name: "s" });
  assert.equal(stops, 1);
  input.end();
  output.end();
});
