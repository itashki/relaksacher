/** @file Regression coverage for tui behavior and its external boundaries. */
import { expect, test, onTestFinished } from "bun:test";
import { renderDashboard } from "../src/adapters/tui.ts";

test("dashboard fits resized terminals and keeps shortcuts on the last row", () => {
  for (const [columns, rows] of [
    [100, 30],
    [40, 18],
    [20, 8],
    [2, 2],
  ]) {
    const screen = renderDashboard({ current: null, queue: [] }, { columns, rows, color: true });
    const lines = Bun.stripANSI(screen).split("\r\n");
    expect(lines.length).toEqual(rows! - 1);
    expect(lines.every((line) => [...line].length < columns!)).toBeTruthy();
    if (columns! > 20) expect(lines.at(-1)?.includes("Ctrl+C")).toBeTruthy();
  }
});

test("styled panels strip terminal commands from streamed content", () => {
  const screen = renderDashboard(
    {
      current: {
        id: 1,
        author: "Alice",
        scope: "Discord",
        model: "model",
        status: "Генерация",
        prompt: "question",
        thinking: "thought",
        text: "answer\x1b[2J",
      },
      queue: [],
    },
    { color: true },
  );
  expect(screen.includes("╭")).toBeTruthy();
  expect(screen.includes("\x1b[36m")).toBeTruthy();
  expect(!screen.includes("\x1b[2J")).toBeTruthy();
  expect(Bun.stripANSI(screen).includes("answer")).toBeTruthy();
});

test("Unicode streams stay within terminal columns without splitting graphemes", () => {
  const text = "👩‍💻你好e\u0301 ".repeat(30);
  const screen = renderDashboard(
    {
      current: {
        id: 1,
        author: "Alice",
        scope: "Discord",
        model: "model",
        status: "Генерация",
        prompt: text,
        thinking: text,
        text,
      },
      queue: [],
    },
    { columns: 36, rows: 30 },
  );
  for (const line of screen.split("\r\n")) expect(Bun.stringWidth(line)).toBeLessThan(36);
  expect(screen).toContain("👩‍💻");
  expect(screen).toContain("e\u0301");
});

test("dashboard shows current streams and queue and strips terminal commands", () => {
  const screen = renderDashboard({
    current: {
      id: 1,
      author: "Alice",
      scope: "Discord",
      model: "model",
      status: "Генерация",
      prompt: "question",
      thinking: "thinking\x1b[2J",
      text: "answer",
    },
    queue: [{ id: 2, author: "Bob", prompt: "next" }],
  });
  for (const value of ["Alice", "thinking", "answer", "Bob", "Очередь: 1"])
    expect(screen.includes(value)).toBeTruthy();
  expect(!screen.includes("\x1b")).toBeTruthy();
});

test("TUI handles real terminal keys, captures logs and restores the screen", async () => {
  const module = Bun.resolveSync("../src/adapters/tui.ts", import.meta.dir);
  const script = `
    import { createTui } from ${JSON.stringify(module)};
    let stops = 0;
    let unsubscribed = 0;
    let musicUnsubscribed = 0;
    const target = { log() {}, info() {}, warn() {}, error() {}, debug() {} };
    const original = target.log;
    const ui = createTui({ consoleTarget: target, music: {
      subscribe(listener) {
        listener([]);
        const timer = setTimeout(() => listener([{ guildId: "1", guildName: "MusicServer", channelId: "2", channelName: "Lounge", status: "playing", current: "https://youtu.be/abcdefghijk", saved: 3, queued: 2, error: "" }]), 20);
        return () => { clearTimeout(timer); musicUnsubscribed++; };
      },
    }, assistant: {
      subscribeTerminal(listener) {
        listener({ current: null, queue: [] });
        return () => { unsubscribed++; };
      },
      stopCurrentGeneration() { stops++; return true; },
    } });
    process.once("SIGINT", () => {
      ui.close();
      ui.close();
      void Bun.write(Bun.stdout, JSON.stringify({ stops, unsubscribed, musicUnsubscribed, restored: target.log === original }) + "CLOSED");
    });
    target.log("captured test log");
    void Bun.write(Bun.stdout, "READY");
  `;
  let rendered = "";
  const child = Bun.spawn([Bun.argv[0], "-e", script], {
    terminal: {
      cols: 100,
      rows: 30,
      data(_terminal, data) {
        rendered += new TextDecoder().decode(data);
      },
    },
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
  await waitFor("MusicServer");
  await waitFor("https://youtu.be/abcdefghijk");
  child.terminal.write("\x03");
  await waitFor("CLOSED");
  expect(await Promise.race([child.exited, Bun.sleep(500).then(() => "still-running")])).toBe(0);
  expect(rendered).toContain('"stops":1');
  expect(rendered).toContain('"unsubscribed":1');
  expect(rendered).toContain('"restored":true');
  expect(rendered).toContain('"musicUnsubscribed":1');
  expect(rendered).toContain("\x1b[?1049h");
  expect(rendered).toContain("\x1b[?25h\x1b[?1049l");
});

test("music telemetry stays visible alongside generation, fits resizing and sanitizes source data", () => {
  const music: import("../src/core/music-status.ts").MusicStatus[] = [
    {
      guildId: "1",
      guildName: "Server\x1b[2J",
      channelId: "2",
      channelName: "Lounge",
      status: "paused",
      current: "https://youtu.be/abcdefghijk",
      saved: 12,
      queued: 4,
      error: "",
      repeat: "all",
      shuffle: true,
    },
  ];
  const state: import("../src/types.ts").TerminalState = {
    current: {
      id: 1,
      author: "Alice",
      scope: "Discord",
      model: "model",
      status: "Генерация",
      prompt: "question",
      thinking: "thought",
      text: "answer",
    },
    queue: [],
  };
  const screen = renderDashboard(state, { music, columns: 100, rows: 34 });
  for (const text of [
    "Музыка",
    "Пауза",
    "Server",
    "Lounge",
    "https://youtu.be/abcdefghijk",
    "12/100",
    "В очереди: 4",
    "Повтор: всё",
    "Случайно: вкл",
    "thought",
    "answer",
  ])
    expect(screen).toContain(text);
  expect(screen).not.toContain("\x1b");
  for (const [columns, rows] of [
    [100, 30],
    [40, 18],
    [20, 8],
    [2, 2],
  ]) {
    const lines = renderDashboard(state, { music, columns, rows, color: true }).split("\r\n");
    expect(lines).toHaveLength(rows - 1);
    expect(lines.every((line) => Bun.stringWidth(line) < columns)).toBe(true);
  }
  expect(renderDashboard({ current: null, queue: [] }, { music: [] })).toContain(
    "нет активных плееров",
  );
  const multi = renderDashboard(
    { current: null, queue: [] },
    {
      music: [
        { ...music[0], status: "stopped", current: "", channelId: null, guildName: "Stopped" },
        { ...music[0], guildId: "3", guildName: "Playing", status: "playing" },
        { ...music[0], guildId: "4", guildName: "Import", status: "importing" },
      ],
      rows: 40,
    },
  );
  expect(multi.indexOf("Playing")).toBeLessThan(multi.indexOf("Import"));
  expect(multi).toContain("Ещё серверов: 1");
});
