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
  expect(multi).toContain("Stopped");
  expect(multi).toContain("/12");
});

test("real TUI keys scroll panels, hold log position and resume following without breaking exit", async () => {
  const module = Bun.resolveSync("../src/adapters/tui.ts", import.meta.dir);
  const script = `
    import { createTui } from ${JSON.stringify(module)};
    const target = { log() {}, info() {}, warn() {}, error() {}, debug() {} };
    const entries = Array.from({ length: 80 }, (_, i) => String(i).padStart(3, "0"));
    const ui = createTui({ consoleTarget: target, assistant: {
      subscribeTerminal(listener) {
        listener({ current: { id: 1, text: entries.map((i) => "ANSWER-" + i).join("\\n") },
          queue: entries.map((i, id) => ({ id, prompt: "QUEUE-" + i })) });
        return () => {};
      },
      stopCurrentGeneration() { return false; },
    } });
    for (const i of entries) target.log("LOG-" + i);
    process.stdin.on("data", (data) => {
      if (data.toString() === "a") target.log("LOG-080");
      if (data.toString() === "b") for (let i = 0; i <= 1000; i++) target.log("EVICT-" + String(i).padStart(4, "0"));
    });
    process.once("SIGINT", () => { ui.close(); void Bun.write(Bun.stdout, "CLOSED"); });
    await Bun.write(Bun.stdout, "READY");
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
  const frame = () => rendered.split("\x1b[H\x1b[2J").at(-1);
  const waitFor = async (condition: () => boolean) => {
    for (let i = 0; i < 200; i++) {
      if (condition()) return;
      await Bun.sleep(10);
    }
    throw new Error(`Expected terminal frame not found: ${frame()}`);
  };
  await waitFor(() => rendered.includes("READY"));
  child.terminal.write("\t\t\r");
  await waitFor(() => frame().includes("▶ Логи") && frame().includes("LOG-079"));
  child.terminal.write("\x1b[H");
  await waitFor(() => frame().includes("LOG-000") && !frame().includes("LOG-079"));
  child.terminal.write("a");
  await waitFor(() => frame().includes("/81"));
  expect(frame()).toContain("LOG-000");
  expect(frame()).not.toContain("LOG-080");
  child.terminal.write("\x1b[B");
  await waitFor(() => frame().includes("LOG-001") && !frame().includes("LOG-000"));
  child.terminal.write("\x1b[6~");
  await waitFor(() => !frame().includes("LOG-001"));
  child.terminal.write("\x1b[F");
  await waitFor(() => frame().includes("LOG-080"));
  child.terminal.write("\t\x1b[H");
  await waitFor(() => frame().includes("▶ Очередь") && frame().includes("QUEUE-000"));
  child.terminal.write("\x1b[F");
  await waitFor(() => frame().includes("QUEUE-079"));
  child.terminal.write("\x1b[Z");
  await waitFor(() => frame().includes("▶ Логи") && frame().includes("LOG-080"));
  child.terminal.write("b");
  await waitFor(() => frame().includes("EVICT-1000"));
  expect(frame()).toContain("/1000");
  child.terminal.write("\x1b[H");
  await waitFor(() => frame().includes("EVICT-0001"));
  child.terminal.resize(40, 12);
  await waitFor(() => frame().split(/\r+\n/).length === 11);
  expect(
    frame()
      .split(/\r+\n/)
      .every((line) => Bun.stringWidth(line) < 40),
  ).toBe(true);
  child.terminal.write("\x03");
  await waitFor(() => rendered.includes("CLOSED"));
  expect(await Promise.race([child.exited, Bun.sleep(500).then(() => "still-running")])).toBe(0);
});

test("real TUI mouse selects and scrolls the pointed panel and disables tracking on exit", async () => {
  const module = Bun.resolveSync("../src/adapters/tui.ts", import.meta.dir);
  const script = `
    import { createTui, buildDashboard } from ${JSON.stringify(module)};
    const target = { log() {}, info() {}, warn() {}, error() {}, debug() {} };
    const rows = Array.from({ length: 80 }, (_, i) => String(i).padStart(3, "0"));
    const state = { current: { id: 1, text: rows.map((i) => "ANSWER-" + i).join("\\n"), thinking: "thought" }, queue: [] };
    const logs = rows.map((i) => "LOG-" + i);
    const ui = createTui({ consoleTarget: target, assistant: {
      subscribeTerminal(listener) { listener(state); return () => {}; },
      stopCurrentGeneration() { throw new Error("Mouse must not trigger stop"); },
    } });
    for (const log of logs) target.log(log);
    process.once("SIGINT", () => { ui.close(); void Bun.write(Bun.stdout, "CLOSED"); });
    await Bun.write(Bun.stdout, "REGIONS" + JSON.stringify(buildDashboard(state, { logs }).regions) + "READY");
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
  const frame = () => rendered.split("\x1b[H\x1b[2J").at(-1);
  const waitFor = async (condition: () => boolean) => {
    for (let i = 0; i < 200; i++) {
      if (condition()) return;
      await Bun.sleep(10);
    }
    throw new Error(`Expected mouse frame not found: ${frame()}`);
  };
  await waitFor(() => rendered.includes("READY"));
  const regions = JSON.parse(
    rendered.match(/REGIONS(.*?)READY/s)[1],
  ) as import("../src/adapters/tui-mouse.ts").PanelRegion[];
  const thinking = regions.find((region) => region.id === "thinking");
  const logs = regions.find((region) => region.id === "logs");
  expect(rendered).toContain("\x1b[?1000h\x1b[?1006h");
  child.terminal.write(`\x1b[<0;2;${thinking.y}M`);
  await waitFor(() => frame().includes("▶ Мысли"));
  child.terminal.write("\x1b[<64;2;");
  await Bun.sleep(10);
  child.terminal.write(`${logs.y}M`);
  await waitFor(() => frame().includes("▶ Логи") && frame().includes("LOG-076"));
  expect(frame()).not.toContain("LOG-079");
  child.terminal.write(`\x1b[<65;2;${logs.y}M`);
  await waitFor(() => frame().includes("LOG-079"));
  child.terminal.write("\r\x1b[H");
  await waitFor(() => frame().includes("LOG-000"));
  child.terminal.resize(40, 12);
  await waitFor(() => frame().split(/\r+\n/).length === 11);
  child.terminal.write("\x1b[<65;2;5M");
  await waitFor(() => frame().includes("LOG-003") && !frame().includes("LOG-000"));
  child.terminal.write("\x03");
  await waitFor(() => rendered.includes("CLOSED"));
  expect(rendered).toContain("\x1b[?1000l\x1b[?1006l\x1b[?25h\x1b[?1049l");
  expect(await Promise.race([child.exited, Bun.sleep(500).then(() => "still-running")])).toBe(0);
});

test("real TUI supports hjkl, slash search editing and navigation, and exits on q", async () => {
  const module = Bun.resolveSync("../src/adapters/tui.ts", import.meta.dir);
  const script = `
    import { createTui } from ${JSON.stringify(module)};
    const target = { log() {}, info() {}, warn() {}, error() {}, debug() {} };
    const rows = Array.from({ length: 80 }, (_, i) => i === 5 || i === 55 ? "needle qshjkl" : "ROW-" + String(i).padStart(3, "0"));
    const ui = createTui({ consoleTarget: target, assistant: {
      subscribeTerminal(listener) { listener({ current: { id: 1, text: rows.join("\\n"), thinking: "thought" }, queue: [] }); return () => {}; },
      stopCurrentGeneration() { throw new Error("Search text must not trigger stop"); },
    } });
    process.once("SIGINT", () => { ui.close(); void Bun.write(Bun.stdout, "CLOSED"); });
    await Bun.write(Bun.stdout, "READY");
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
  const rawFrame = () => rendered.split("\x1b[H\x1b[2J").at(-1);
  const frame = () => Bun.stripANSI(rawFrame());
  const waitFor = async (condition: () => boolean) => {
    for (let i = 0; i < 200; i++) {
      if (condition()) return;
      await Bun.sleep(10);
    }
    throw new Error(`Expected search frame not found: ${frame()}`);
  };
  await waitFor(() => rendered.includes("READY"));
  child.terminal.write("\r\x1b[H");
  await waitFor(() => frame().includes("ROW-000"));
  child.terminal.write("j");
  await waitFor(() => frame().includes("ROW-001") && !frame().includes("ROW-000"));
  child.terminal.write("k");
  await waitFor(() => frame().includes("ROW-000"));
  child.terminal.write("l");
  await waitFor(() => frame().includes("▶ Мысли"));
  child.terminal.write("h");
  await waitFor(() => frame().includes("▶ Ответ") && frame().includes("ROW-000"));
  child.terminal.write("?");
  await waitFor(() => frame().includes("h/l — панели"));
  child.terminal.write("/needle qshjkl");
  await waitFor(() => frame().includes("/needle qshjkl█") && frame().includes("1/2"));
  expect(frame()).toContain("▶ Ответ");
  expect(rawFrame()).toContain("\x1b[1;30;43mneedle qshjkl\x1b[0m");
  expect(rendered).not.toContain("CLOSED");
  child.terminal.write("\r");
  await waitFor(() => frame().includes("n/N далее/назад"));
  child.terminal.write("n");
  await waitFor(() => frame().includes("2/2"));
  expect(frame()).toContain("ROW-056");
  child.terminal.write("n");
  await waitFor(() => frame().includes("1/2"));
  child.terminal.write("N");
  await waitFor(() => frame().includes("2/2"));
  child.terminal.write("/needleX");
  await waitFor(() => frame().includes("нет совпадений"));
  child.terminal.write("\x7f");
  await waitFor(() => frame().includes("/needle█") && frame().includes("1/2"));
  child.terminal.resize(40, 12);
  await waitFor(() => frame().split(/\r+\n/).length === 11);
  expect(
    frame()
      .split(/\r+\n/)
      .every((line) => Bun.stringWidth(line) < 40),
  ).toBe(true);
  child.terminal.write("\x1b");
  await waitFor(() => !frame().includes("/needle"));
  expect(frame()).toContain("ROW-056");
  child.terminal.write("q");
  await waitFor(() => rendered.includes("CLOSED"));
  expect(rendered).toContain("\x1b[?1000l\x1b[?1006l");
  expect(await Promise.race([child.exited, Bun.sleep(500).then(() => "still-running")])).toBe(0);
});
