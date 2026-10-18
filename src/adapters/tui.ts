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
    if (cells + size > width) { result.push(row); row = ""; cells = 0; }
    row += char;
    cells += size;
  }
  result.push(row);
  return result;
}

/** Render a bounded screen; long streams show their most recent lines. */
export function renderDashboard(state: import("../types.ts").TerminalState, { columns = 100, rows = 30, logs = [], notice = "" }: {columns?: number; rows?: number; logs?: string[]; notice?: string} = {}) {
  const width = Math.max(1, columns - 2);
  const lines: string[] = [];
  const add = (value = "") => lines.push(wrapLine(clean(value).replace(/\n/g, " "), width)[0]);
  const section = (title: string) => add(`── ${title} ${"─".repeat(width)}`);
  const tail = (value: unknown, count: number) => {
    const wrapped = clean(value || "…").split("\n").flatMap((line) => wrapLine(line, width));
    wrapped.slice(-count).forEach(add);
  };
  const current = state.current ?? state.last;
  add("РЕЛАКСАЧЕР • операторская панель");
  add(state.current ? `● #${current.id} ${current.status} • ${current.model}` : "○ Ожидание запроса");
  if (current) {
    add(`${current.author} • ${current.scope}`);
    add(`Запрос: ${current.prompt}`);
  } else { add(); add(); }
  const queueRows = Math.min(4, state.queue.length);
  const streamRows = Math.max(1, Math.floor((rows - 14 - queueRows) / 2));
  section(state.current ? "Мысли · поток" : "Мысли · последний запрос");
  tail(current?.thinking, streamRows);
  section("Ответ · поток");
  tail(current?.text, streamRows);
  section(`Очередь: ${state.queue.length}`);
  state.queue.slice(0, queueRows).forEach((request, index) =>
    add(`${index + 1}. #${request.id} ${request.author} • ${request.prompt}`));
  if (state.queue.length > queueRows) add(`… ещё ${state.queue.length - queueRows}`);
  section("Логи");
  logs.slice(-2).forEach(add);
  add(notice);
  add("[S] остановить генерацию   [H] помощь   [Ctrl+C] завершить бота");
  const footer = lines.pop();
  return [...lines.slice(0, Math.max(0, rows - 2)), footer].join("\r\n");
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
      columns: output.columns, rows: output.rows, logs, notice,
    }).split("\r\n").map((line, index) => index === 0 ? `\x1b[1;36m${line}\x1b[0m`
      : line.startsWith("──") ? `\x1b[36m${line}\x1b[0m` : line).join("\r\n");
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
