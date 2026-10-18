import { expect, test, onTestFinished } from "bun:test";
import { renderDashboard } from "../src/adapters/tui.ts";

test("dashboard fits resized terminals and keeps shortcuts on the last row", () => {
  for (const [columns, rows] of [[100, 30], [40, 18], [20, 8], [2, 2]]) {
    const screen = renderDashboard({ current: null, queue: [] }, { columns, rows, color: true });
    const lines = Bun.stripANSI(screen).split("\r\n");
    expect(lines.length).toEqual(rows! - 1);
    expect(lines.every((line) => [...line].length < columns!)).toBeTruthy();
    if (columns! > 20) expect(lines.at(-1)?.includes("Ctrl+C")).toBeTruthy();
  }
});

test("styled panels strip terminal commands from streamed content", () => {
  const screen = renderDashboard({ current: { id: 1, author: "Alice", scope: "Discord",
    model: "model", status: "Генерация", prompt: "question", thinking: "thought", text: "answer\x1b[2J" },
    queue: [] }, { color: true });
  expect(screen.includes("╭")).toBeTruthy();
  expect(screen.includes("\x1b[36m")).toBeTruthy();
  expect(!screen.includes("\x1b[2J")).toBeTruthy();
  expect(Bun.stripANSI(screen).includes("answer")).toBeTruthy();
});

test("Unicode streams stay within terminal columns without splitting graphemes", () => {
  const text = "👩‍💻你好e\u0301 ".repeat(30);
  const screen = renderDashboard({ current: { id: 1, author: "Alice", scope: "Discord",
    model: "model", status: "Генерация", prompt: text, thinking: text, text }, queue: [] },
    { columns: 36, rows: 30 });
  for (const line of screen.split("\r\n")) expect(Bun.stringWidth(line)).toBeLessThan(36);
  expect(screen).toContain("👩‍💻");
  expect(screen).toContain("e\u0301");
});

test("dashboard shows current streams and queue and strips terminal commands", () => {
  const screen = renderDashboard({ current: { id: 1, author: "Alice", scope: "Discord",
    model: "model", status: "Генерация", prompt: "question", thinking: "thinking\x1b[2J", text: "answer" },
    queue: [{ id: 2, author: "Bob", prompt: "next" }] });
  for (const value of ["Alice", "thinking", "answer", "Bob", "Очередь: 1"]) expect(screen.includes(value)).toBeTruthy();
  expect(!screen.includes("\x1b")).toBeTruthy();
});

test("TUI handles real terminal keys, captures logs and restores the screen", async () => {
  const module = Bun.resolveSync("../src/adapters/tui.ts", import.meta.dir);
  const script = `
    import { createTui } from ${JSON.stringify(module)};
    let stops = 0;
    let unsubscribed = 0;
    const target = { log() {}, info() {}, warn() {}, error() {}, debug() {} };
    const original = target.log;
    const ui = createTui({ consoleTarget: target, assistant: {
      subscribeTerminal(listener) {
        listener({ current: null, queue: [] });
        return () => { unsubscribed++; };
      },
      stopCurrentGeneration() { stops++; return true; },
    }, onInterrupt() {
      ui.close();
      ui.close();
      void Bun.write(Bun.stdout, JSON.stringify({ stops, unsubscribed, restored: target.log === original }) + "CLOSED");
    } });
    target.log("captured test log");
    void Bun.write(Bun.stdout, "READY");
  `;
  let rendered = "";
  const child = Bun.spawn([Bun.argv[0], "-e", script], {
    terminal: { cols: 100, rows: 30, data(_terminal, data) { rendered += new TextDecoder().decode(data); } },
  });
  onTestFinished(async () => {
    child.kill();
    await child.exited;
    child.terminal.close();
  });
  const waitFor = async (value: string) => {
    for (let attempt = 0; attempt < 200; attempt++) {
      if (rendered.includes(value)) return;
      await Bun.sleep(10);
    }
    throw new Error(`Terminal did not emit ${value}: ${rendered}`);
  };
  await waitFor("READY");
  child.terminal.write("s");
  await waitFor("Остановка запрошена.");
  await waitFor("captured test log");
  child.terminal.write("\x03");
  await waitFor("CLOSED");
  expect(rendered).toContain('"stops":1');
  expect(rendered).toContain('"unsubscribed":1');
  expect(rendered).toContain('"restored":true');
  expect(rendered).toContain("\x1b[?1049h");
  expect(rendered).toContain("\x1b[?25h\x1b[?1049l");
});
