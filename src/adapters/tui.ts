/** @file Dependency-free ANSI operator dashboard. */
import { emitKeypressEvents } from "node:readline";
import { format, stripVTControlCharacters } from "node:util";

// Remove terminal commands from model output, prompts and logs.
const clean = (value: unknown) => stripVTControlCharacters(String(value ?? ""))
  .replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, "");
const cellWidth = (char: string) => /\p{Mark}/u.test(char) ? 0
  : /[\u1100-\u115f\u2329\u232a\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe10-\ufe19\ufe30-\ufe6f\uff01-\uff60\uffe0-\uffe6\u{1f000}-\u{1faff}\u{20000}-\u{3ffff}]/u.test(char) ? 2 : 1;
function wrapLine(line: string, width: number) {
  const result = [];
  let row = "";
  let cells = 0;
  for (const char of line) {
    const size = cellWidth(char);
    if (size > width) continue;
    if (cells + size > width) { result.push(row); row = ""; cells = 0; }
    row += char;
    cells += size;
  }
  result.push(row);
  return result;
}

/** Render a bounded screen; long streams show their most recent lines. */
export function renderDashboard(state: import("../types.ts").TerminalState, { columns = 100, rows = 30, logs = [], notice = "", color = false }: {columns?: number; rows?: number; logs?: string[]; notice?: string; color?: boolean} = {}) {
  const width = Math.max(1, Math.floor(columns) - 1);
  const height = Math.max(1, Math.floor(rows) - 1);
  const lines: string[] = [];
  const paint = (text: string, code: string) => color ? `\x1b[${code}m${text}\x1b[0m` : text;
  const fit = (value: unknown, size = width) => wrapLine(clean(value).replace(/\n/g, " "), Math.max(1, size))[0] ?? "";
  const cells = (value: string) => [...value].reduce((sum, char) => sum + cellWidth(char), 0);
  const add = (value = "", code = "0") => lines.push(paint(fit(value), code));
  const current = state.current ?? state.last;
  const footer = " S стоп   H помощь   Ctrl+C выход";
  add(" РЕЛАКСАЧЕР  /  операторская панель", "1;36");
  add(state.current ? ` ● ${current?.status}  ·  #${current?.id}  ·  ${current?.model}` : " ○ Ожидание запроса", state.current ? "1;32" : "2");
  if (current) {
    add(` ${current.author}  /  ${current.scope}`, "36");
    add(` › ${current.prompt}`);
  }
  const panel = (title: string, content: string[], count: number, code: string) => {
    if (width < 8) {
      add(title, code);
      content.slice(-count).forEach((line) => add(line));
      return;
    }
    const inner = width - 4;
    const label = fit(` ${title} `, width - 2);
    add(`╭${label}${"─".repeat(Math.max(0, width - cells(label) - 2))}╮`, code);
    const wrapped = content.flatMap((line) => clean(line).split("\n").flatMap((part) => wrapLine(part, inner)));
    const visible = wrapped.slice(-count);
    while (visible.length < count) visible.push("");
    for (const line of visible) {
      const text = fit(line, inner);
      lines.push(paint("│", code) + " " + text + " ".repeat(Math.max(0, inner - cells(text))) + " " + paint("│", code));
    }
    add(`╰${"─".repeat(width - 2)}╯`, code);
  };
  const queueRows = Math.min(3, state.queue.length);
  const logRows = Math.min(2, logs.length);
  // Reserve panel borders, metadata, notices and the pinned keyboard shortcuts.
  const budget = height - lines.length - 8 - Math.max(1, queueRows) - logRows - (notice ? 1 : 0) - 1;
  if (budget >= 2) {
    panel(state.current ? "Мысли · поток" : "Мысли · последний запрос", [current?.thinking || "Пока нет мыслей…"], Math.max(1, Math.floor(budget / 2)), "2;36");
    panel("Ответ · поток", [current?.text || "Ответ появится здесь…"], Math.max(1, Math.ceil(budget / 2)), "36");
    panel(`Очередь: ${state.queue.length}`, state.queue.length ? state.queue.slice(0, queueRows).map((request, index) =>
      `${index + 1}. #${request.id} ${request.author} · ${request.prompt}` + (index === queueRows - 1 && state.queue.length > queueRows ? `  (+${state.queue.length - queueRows})` : "")) : ["Очередь пуста"], Math.max(1, queueRows), "33");
    if (logRows) { add(" Логи", "2"); logs.slice(-logRows).forEach((line) => add(` ${line}`, "2")); }
  } else {
    add(` Очередь: ${state.queue.length}`, "33");
    const available = Math.max(0, height - lines.length - 2 - (notice ? 1 : 0));
    if (available) {
      add(" Ответ", "36");
      if (available > 1) clean(current?.text || "Ответ появится здесь…").split("\n").flatMap((line) => wrapLine(line, width)).slice(-(available - 1)).forEach((line) => add(line));
    }
  }
  if (notice) add(` ◆ ${notice}`, "33");
  const body = lines.slice(0, height - 1);
  while (body.length < height - 1) body.push("");
  return [...body, paint(fit(footer), "7")].join("\r\n");
}

/** Start full-screen terminal monitoring and restore terminal state on close. */
export function createTui({ assistant, input = process.stdin, output = process.stdout,
  consoleTarget = console, onInterrupt = () => process.emit("SIGINT") }: { assistant: import("../types.ts").Assistant; input?: NodeJS.ReadableStream & {isRaw?: boolean; setRawMode?: (mode: boolean) => void}; output?: NodeJS.WritableStream & {columns?: number; rows?: number}; consoleTarget?: Console; onInterrupt?: () => void }) {
  let state: import("../types.ts").TerminalState = { current: null, last: null, queue: [] };
  const logs: string[] = [];
  const original = new Map<"log" | "info" | "warn" | "error" | "debug", (...args: unknown[]) => void>();
  let notice = "";
  let closed = false;
  let dirty = true;
  const wasRaw = input.isRaw ?? false;
  const wasPaused = input.isPaused();
  const draw = () => {
    if (closed || !dirty) return;
    dirty = false;
    const screen = renderDashboard(state, {
      columns: output.columns, rows: output.rows, logs, notice, color: true,
    });
    output.write(`\x1b[H\x1b[2J${screen}`);
  };
  const unsubscribe = assistant.subscribeTerminal((next) => { state = next; dirty = true; });
  for (const level of ["log", "info", "warn", "error", "debug"] as const) {
    original.set(level, consoleTarget[level]);
    consoleTarget[level] = (...args) => {
      // Reasoning already has its own panel; avoid duplicating the entire stream.
      if (args[0] === "[thinking]") return;
      logs.push(clean(format(...args)).replace(/\n/g, " ").slice(0, 1000));
      if (logs.length > 50) logs.shift();
      dirty = true;
    };
  }
  output.write("\x1b[?1049h\x1b[?25l");
  emitKeypressEvents(input);
  input.setRawMode?.(true);
  input.resume();
  const onKey = (text: string, key: import("node:readline").Key = {}) => {
    if (key.ctrl && key.name === "c") { onInterrupt(); return; }
    if (key.name === "s" || text === "s" || text === "S") {
      notice = assistant.stopCurrentGeneration() ? "Остановка запрошена." : "Нет активной генерации.";
    } else if (key.name === "h" || text === "h") {
      notice = "S — остановить текущий ответ; очередь продолжится. Ctrl+C — выход.";
    }
    dirty = true;
  };
  const onResize = () => { dirty = true; };
  input.on("keypress", onKey);
  output.on("resize", onResize);
  const timer = setInterval(draw, 80);
  timer.unref?.();
  draw();
  function close() {
    if (closed) return;
    closed = true;
    clearInterval(timer);
    unsubscribe();
    input.off("keypress", onKey);
    input.off("end", close);
    output.off("resize", onResize);
    input.setRawMode?.(wasRaw);
    if (wasPaused) input.pause();
    for (const [level, method] of original) consoleTarget[level] = method;
    output.write("\x1b[?25h\x1b[?1049l");
  }
  input.once("end", close);
  return { close };
}
