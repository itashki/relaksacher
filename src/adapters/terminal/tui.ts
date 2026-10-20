/** @file Dependency-free ANSI operator dashboard with independent scrollable panels. */
import { dashboardHeader } from "./header.ts";
import {
  createStatistics,
  type RequestStatistics,
  type StatisticsSource,
} from "../../core/statistics.ts";
import { createTerminalSession, type TerminalSession } from "./session.ts";
import { statisticsLines } from "./statistics.ts";
import type { MusicStatus, MusicStatusSource } from "../../core/music/status.ts";
import { PassThrough } from "node:stream";
import {
  createMouseDecoder,
  panelAt,
  enableMouse,
  disableMouse,
  type PanelRegion,
} from "./mouse.ts";
import {
  createSearch,
  searchLines,
  searchIndex,
  highlightMatches,
  type SearchState,
  type SearchMove,
} from "./search.ts";
import { emitKeypressEvents } from "node:readline";
import {
  createNavigation,
  visibleLines,
  scrollPanel,
  selectPanel,
  panelOrder,
  type PanelId,
  type Navigation,
  type Viewport,
} from "./scroll.ts";

// Remove terminal commands from model output, prompts and logs.
const clean = (value: unknown) =>
  // oxlint-disable-next-line no-control-regex -- Strip terminal control bytes from untrusted text.
  Bun.stripANSI(String(value ?? "")).replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, "");
const wrapLine = (line: string, width: number) =>
  Bun.wrapAnsi(line, Math.max(1, width), {
    hard: true,
    wordWrap: false,
    trim: false,
  })
    .split("\n")
    .map((row) => Bun.sliceAnsi(row, 0, Math.max(1, width)));
const wrappedLines = (content: string[], width: number) =>
  content.flatMap((line) =>
    clean(line)
      .split("\n")
      .flatMap((part) => wrapLine(part, width)),
  );

/** Terminal dimensions, local content and independent navigation state for one render. */
export type DashboardOptions = {
  statistics?: RequestStatistics;
  columns?: number;
  rows?: number;
  logs?: string[];
  notice?: string;
  color?: boolean;
  music?: MusicStatus[];
  navigation?: Navigation;
  search?: SearchState;
  searchMove?: SearchMove;
  /** Presence enables the restart button; true indicates a pending restart. */
  restarting?: boolean;
  /** Presence enables the AI pause/resume control. */
  repliesPaused?: boolean;
};
const panelNames: Record<PanelId, string> = {
  answer: "Ответ",
  thinking: "Мысли",
  logs: "Логи",
  queue: "Очередь",
  music: "Музыка",
  prompt: "Запрос",
};

/** Render a bounded dashboard; scroll positions are independent and untrusted text is escaped. */
export function renderDashboard(
  state: import("../../types.ts").TerminalState,
  options: DashboardOptions = {},
) {
  return buildDashboard(state, options).screen;
}

/** Build the screen, scroll metrics and clipped mouse hit regions from the same layout. */
export function buildDashboard(
  state: import("../../types.ts").TerminalState,
  {
    columns = 100,
    rows = 30,
    logs = [],
    notice = "",
    color = false,
    music,
    navigation = createNavigation(),
    search = createSearch(),
    searchMove,
    restarting,
    repliesPaused,
    statistics,
  }: DashboardOptions = {},
) {
  const width = Math.max(1, Math.floor(columns) - 1);
  const height = Math.max(1, Math.floor(rows));
  const bodyHeight = height - (search.panel ? 1 : 0);
  const bordered = width >= 8;
  const inner = bordered ? width - 4 : width;
  const lines: string[] = [];
  const viewports: Partial<Record<PanelId, Viewport>> = {};
  const regions: PanelRegion[] = [];
  const paint = (value: string, code: string) => (color ? `\x1b[${code}m${value}\x1b[0m` : value);
  const fit = (value: unknown, size = width) =>
    Bun.sliceAnsi(clean(value).replace(/\n/g, " "), 0, Math.max(1, size));
  const add = (value = "", code = "0") => lines.push(paint(fit(value), code));
  const current = state.current ?? state.last;
  const { restartRegion, pauseRegion, header } = dashboardHeader(width, restarting, repliesPaused);
  add(header, "1;36");
  if (height > 3)
    add(
      state.current
        ? ` ● ${current?.status} · #${current?.id} · ${current?.model}`
        : " ○ Ожидание запроса",
      state.current ? "1;32" : "2",
    );
  if (current && height > 7) add(` ${current.author} / ${current.scope}`, "36");
  if (statistics && height > 7)
    for (const line of statisticsLines(statistics)
      .flatMap((line) => wrapLine(line, width))
      .slice(0, Math.max(0, height - lines.length - 4)))
      add(line, "2");
  const content: Record<PanelId, string[]> = {
    prompt: [String(current?.prompt || "Запрос появится здесь…")],
    thinking: [current?.thinking || "Пока нет мыслей…"],
    answer: [current?.text || "Ответ появится здесь…"],
    logs: logs.length ? logs : ["Пока нет логов…"],
    queue: state.queue.length
      ? state.queue.map(
          (request, index) => `${index + 1}. #${request.id} ${request.author} · ${request.prompt}`,
        )
      : ["Очередь пуста"],
    music: ["нет активных плееров"],
  };
  if (music?.length) {
    const labels: Record<MusicStatus["status"], string> = {
      stopped: "Остановлено",
      connecting: "Подключение",
      buffering: "Загрузка звука",
      playing: "Играет",
      paused: "Пауза",
      idle: "Очередь закончилась",
      importing: "Импорт плейлиста",
    };
    const sorted = [...music].sort(
      (a, b) =>
        Number(Boolean(b.current || b.channelId || b.status === "importing")) -
        Number(Boolean(a.current || a.channelId || a.status === "importing")),
    );
    content.music = sorted.flatMap((s) => [
      `${labels[s.status]} · ${s.guildName} / ${s.channelName || s.channelId || "Не в войсчате"}`,
      `Трек: ${s.current || "—"}`,
      `Повтор: ${{ off: "выкл", track: "трек", all: "всё" }[s.repeat ?? "off"]} · Случайно: ${s.shuffle ? "вкл" : "выкл"}`,
      `Сохранено: ${s.saved}/100 · В очереди: ${s.queued}`,
      ...(s.error ? [`Ошибка: ${s.error}`] : []),
    ]);
  }
  const searched = search.panel
    ? searchLines(
        content[search.panel].flatMap((line) => clean(line).split("\n")),
        search.query,
        (line) => wrapLine(line, inner),
      )
    : null;
  const matchIndex = searchIndex(search.match, searched?.matches.length ?? 0, searchMove);
  const matchRow = searched?.matches[matchIndex]?.row;
  const available = panelOrder.filter((id) => id !== "music" || music !== undefined);
  const selected = available.includes(navigation.selected) ? navigation.selected : "answer";
  const bodyRows = Math.max(0, bodyHeight - lines.length - (notice ? 1 : 0));
  const overhead = bordered ? 2 : 1;
  const focused = navigation.expanded || bodyRows < available.length * (overhead + 1);
  const shown = focused ? [selected] : available;
  const sizes = Object.fromEntries(shown.map((id) => [id, 1])) as Partial<Record<PanelId, number>>;
  let extra = Math.max(0, bodyRows - shown.length * (overhead + 1));
  const priorities: PanelId[] = focused
    ? [selected]
    : [
        ...(music !== undefined ? (["music", "music", "music"] as PanelId[]) : []),
        "answer",
        "thinking",
        "logs",
        "answer",
        "queue",
      ];
  for (let i = 0; extra > 0; i++, extra--) {
    const id = priorities[i % priorities.length];
    sizes[id] = (sizes[id] ?? 1) + 1;
  }
  for (const id of shown) {
    if (lines.length >= bodyHeight - (notice ? 1 : 0)) break;
    const top = lines.length + 1;
    const count = sizes[id] ?? 1;
    const searching = search.panel === id;
    const position =
      searching && searchMove && matchRow !== undefined ? matchRow : navigation.positions[id];
    const view = visibleLines(
      searching ? searched.lines : wrappedLines(content[id], inner),
      count,
      position,
    );
    viewports[id] = { start: view.start, total: view.total, rows: view.rows };
    const range = `${view.start + 1}–${Math.min(view.total, view.start + count)}/${view.total}`;
    const title = `${id === selected ? "▶ " : ""}${panelNames[id]}${id === "queue" ? `: ${state.queue.length}` : ""} · ${range}${position === "tail" ? " ↓" : ""}`;
    const code = id === selected ? "1;36" : id === "music" ? "35" : "2;36";
    if (bordered) {
      const label = fit(` ${title} `, width - 2);
      add(`╭${label}${"─".repeat(Math.max(0, width - Bun.stringWidth(label) - 2))}╮`, code);
      for (let index = 0; index < count; index++) {
        const text = fit(view.lines[index] ?? "", inner);
        lines.push(
          paint("│", code) +
            " " +
            (color && searching
              ? highlightMatches(text, searched.spans[view.start + index], matchIndex)
              : text) +
            " ".repeat(Math.max(0, inner - Bun.stringWidth(text))) +
            " " +
            paint("│", code),
        );
      }
      add(`╰${"─".repeat(width - 2)}╯`, code);
    } else {
      add(title, code);
      view.lines.forEach((line, index) => {
        const text = fit(line);
        if (color && searching)
          lines.push(highlightMatches(text, searched.spans[view.start + index], matchIndex));
        else add(text);
      });
    }
    regions.push({
      id,
      x: 1,
      y: top,
      width,
      height: Math.max(0, Math.min(lines.length, bodyHeight - (notice ? 1 : 0)) - top + 1),
    });
  }
  const body = lines.slice(0, Math.max(0, bodyHeight - (notice ? 1 : 0)));
  if (notice) body.push(paint(fit(` ◆ ${notice}`), "33"));
  while (body.length < bodyHeight) body.push("");
  const footer = search.panel
    ? ` /${search.query}${search.editing ? "█" : ""} · ${matchIndex >= 0 ? `${matchIndex + 1}/${searched.matches.length}` : search.query ? "нет совпадений" : "введите запрос"} | ${search.editing ? "Enter искать Esc отмена" : "n/N далее/назад Esc закрыть q выход"}`
    : "";
  return {
    screen: (search.panel ? [...body, paint(fit(footer), "7")] : body).join("\r\n"),
    viewports,
    regions,
    available,
    restartRegion,
    pauseRegion,
    searchResult: { index: matchIndex, row: matchRow, total: searched?.matches.length ?? 0 },
  };
}

/** Start full-screen terminal monitoring and restore terminal state on close. */
export function createTui({
  assistant,
  music,
  statistics = createStatistics(),
  session = createTerminalSession(),
  input = process.stdin,
  output = process.stdout,
  consoleTarget = console,
  onInterrupt = () => process.emit("SIGINT"),
  onRestart,
}: {
  onRestart?: () => Promise<void>;
  statistics?: StatisticsSource;
  session?: TerminalSession;
  music?: MusicStatusSource;
  assistant: import("../../types.ts").Assistant;
  input?: NodeJS.ReadableStream & {
    readableFlowing?: boolean | null;
    isRaw?: boolean;
    setRawMode?: (mode: boolean) => void;
  };
  output?: NodeJS.WritableStream & { columns?: number; rows?: number };
  consoleTarget?: Console;
  onInterrupt?: () => void;
}) {
  let state: import("../../types.ts").TerminalState = { current: null, last: null, queue: [] };
  let musicState: MusicStatus[] | undefined = music ? [] : undefined;
  const { logs, navigation } = session;
  let search = session.search;
  let searchMove: SearchMove | undefined;
  let viewports: Partial<Record<PanelId, Viewport>> = {};
  let regions: PanelRegion[] = [];
  let restartRegion: ReturnType<typeof buildDashboard>["restartRegion"];
  let pauseRegion: ReturnType<typeof buildDashboard>["pauseRegion"];
  let restarting = false;
  const original = new Map<
    "log" | "info" | "warn" | "error" | "debug",
    (...args: unknown[]) => void
  >();
  let notice = "";
  let closed = false;
  let dirty = true;
  let statisticsVersion = "";
  const wasRaw = input.isRaw ?? false;
  // A fresh stdin has readableFlowing=null but isPaused()=false. Restoring only
  // isPaused leaves the read started by resume() alive after the TUI closes.
  const wasFlowing = input.readableFlowing === true;
  const draw = () => {
    if (closed) return;
    const snapshot = statistics.snapshot();
    const version = `${Math.floor(snapshot.uptimeMs / 1000)}:${snapshot.total}`;
    if (version !== statisticsVersion) dirty = true;
    statisticsVersion = version;
    if (!dirty) return;
    dirty = false;
    const rendered = buildDashboard(state, {
      columns: output.columns,
      rows: output.rows,
      logs,
      notice,
      color: true,
      music: musicState,
      statistics: snapshot,
      navigation,
      search,
      searchMove,
      repliesPaused: assistant.repliesPaused?.(),
      restarting: onRestart ? restarting : undefined,
    });
    if (searchMove && search.panel && rendered.searchResult.row !== undefined) {
      navigation.positions[search.panel] = rendered.searchResult.row;
    }
    search.match = rendered.searchResult.index;
    searchMove = undefined;
    viewports = rendered.viewports;
    regions = rendered.regions;
    restartRegion = rendered.restartRegion;
    pauseRegion = rendered.pauseRegion;
    for (const [id, view] of Object.entries(viewports)) {
      if (navigation.positions[id as PanelId] !== "tail")
        navigation.positions[id as PanelId] = view.start;
    }
    output.write(`\x1b[H\x1b[2J${rendered.screen}`);
  };
  const unsubscribe = assistant.subscribeTerminal((next) => {
    if ((next.current ?? next.last)?.id !== (state.current ?? state.last)?.id) {
      navigation.positions.answer = "tail";
      navigation.positions.thinking = "tail";
      navigation.positions.prompt = 0;
      if (search.panel && ["answer", "thinking", "prompt"].includes(search.panel))
        search = createSearch();
    }
    state = next;
    dirty = true;
  });
  const unsubscribeMusic = music?.subscribe((next) => {
    musicState = next;
    dirty = true;
  });
  for (const level of ["log", "info", "warn", "error", "debug"] as const) {
    original.set(level, consoleTarget[level]);
    consoleTarget[level] = (...args) => {
      // Reasoning already has its own panel; avoid duplicating the entire stream.
      if (args[0] === "[thinking]") return;
      logs.push(
        clean(
          args
            .map((value) =>
              typeof value === "string"
                ? value
                : Bun.inspect(value, { colors: false, compact: true }),
            )
            .join(" "),
        ).slice(0, 4000),
      );
      if (logs.length > 1000) {
        const removed = logs.shift();
        if (typeof navigation.positions.logs === "number") {
          const screenWidth = Math.max(1, (output.columns ?? 100) - 1);
          const width = screenWidth >= 8 ? screenWidth - 4 : screenWidth;
          navigation.positions.logs = Math.max(
            0,
            navigation.positions.logs - wrappedLines([removed], width).length,
          );
        }
      }
      dirty = true;
    };
  }
  output.write(`\x1b[?1049h\x1b[?25l${enableMouse}`);
  const requestRestart = () => {
    if (!onRestart || restarting || closed) return;
    restarting = true;
    notice =
      "Рестарт: ожидаю завершения запросов. Новые сообщения будут обработаны после рестарта.";
    dirty = true;
    void Promise.resolve()
      .then(onRestart)
      .then(
        () => {
          if (!closed) notice = "Рестарт завершён.";
        },
        (error) => {
          if (!closed) notice = `Ошибка рестарта: ${String(error)}`;
        },
      )
      .finally(() => {
        restarting = false;
        dirty = true;
      });
  };
  const toggleReplies = () => {
    if (!assistant.setRepliesPaused) return;
    const paused = !assistant.repliesPaused();
    assistant.setRepliesPaused(paused);
    notice = paused ? "Ответы ИИ временно отключены." : "Ответы ИИ включены.";
    dirty = true;
  };
  // readline requires a Node stream; feed it only bytes which are not mouse reports.
  const keyboard = new PassThrough();
  emitKeypressEvents(keyboard);
  const mouse = createMouseDecoder(
    (event) => {
      if (dirty) draw();
      if (
        event.kind === "click" &&
        restartRegion &&
        event.y === restartRegion.y &&
        event.x >= restartRegion.x &&
        event.x < restartRegion.x + restartRegion.width
      ) {
        requestRestart();
        return;
      }
      if (
        event.kind === "click" &&
        pauseRegion &&
        event.y === 1 &&
        event.x >= pauseRegion.x &&
        event.x < pauseRegion.x + pauseRegion.width
      ) {
        toggleReplies();
        return;
      }
      const id = panelAt(regions, event.x, event.y);
      if (!id) return;
      if (id !== navigation.selected) search = createSearch();
      navigation.selected = id;
      if (event.kind !== "click") scrollPanel(navigation, viewports[id], event.kind, 3);
      dirty = true;
    },
    (data) => {
      if (!closed) keyboard.write(data);
    },
  );
  const onData = (data: Uint8Array | string) => mouse.write(data);
  input.setRawMode?.(true);
  input.resume();
  const onKey = (text: string, key: import("node:readline").Key = {}) => {
    if (key.ctrl && key.name === "c") {
      onInterrupt();
      return;
    }
    if (search.editing) {
      if (key.name === "escape") {
        if (search.panel) navigation.positions[search.panel] = search.savedPosition;
        search = createSearch();
      } else if (key.name === "return") {
        search.editing = false;
      } else if (key.name === "backspace" || key.name === "delete") {
        search.query = Array.from(search.query).slice(0, -1).join("");
        searchMove = "first";
      } else if (key.ctrl && key.name === "u") {
        search.query = "";
        searchMove = "first";
      } else if (text && !key.ctrl && !key.meta && !/\p{Cc}/u.test(text)) {
        search.query = Array.from(search.query + text)
          .slice(0, 256)
          .join("");
        searchMove = "first";
      }
      dirty = true;
      return;
    }
    if (key.name === "q" && !key.ctrl && !key.meta) {
      onInterrupt();
      return;
    }
    if (text === "/") {
      search = {
        ...createSearch(),
        panel: navigation.selected,
        editing: true,
        savedPosition: navigation.positions[navigation.selected],
      };
      notice = "";
    } else if (key.name === "escape") {
      search = createSearch();
    } else if (key.name === "n" && search.query) {
      if (dirty) draw();
      searchMove = key.shift ? "previous" : "next";
    } else if (key.name === "tab" || key.name === "h" || key.name === "l") {
      selectPanel(
        navigation,
        panelOrder.filter((id) => id !== "music" || musicState !== undefined),
        key.name === "h" || (key.name === "tab" && key.shift),
      );
      search = createSearch();
    } else if (key.name === "return") {
      navigation.expanded = !navigation.expanded;
    } else if (["up", "down", "pageup", "pagedown", "home", "end", "j", "k"].includes(key.name)) {
      if (dirty) draw();
      scrollPanel(
        navigation,
        viewports[navigation.selected],
        key.name === "j" ? "down" : key.name === "k" ? "up" : key.name,
      );
    } else if (key.name === "p" && !key.ctrl && !key.meta) {
      toggleReplies();
    } else if (key.name === "r" && !key.ctrl && !key.meta) {
      requestRestart();
    } else if (key.name === "s" || text === "s" || text === "S") {
      notice = assistant.stopCurrentGeneration()
        ? "Остановка запрошена."
        : "Нет активной генерации.";
    } else if (text === "?") {
      notice =
        "Tab/Shift+Tab, h/l — панели; q — выход; P — пауза ИИ; R — рестарт; j/k — вниз/вверх; / — поиск; n/N — совпадения; Enter — развернуть; мышь — клик/скролл.";
    }
    dirty = true;
  };
  const onResize = () => {
    dirty = true;
  };
  keyboard.on("keypress", onKey);
  input.on("data", onData);
  output.on("resize", onResize);
  const timer = setInterval(draw, 80);
  timer.unref?.();
  draw();
  /** Unsubscribe, restore terminal modes and release the stdin read started by the dashboard. */
  function close() {
    if (closed) return;
    closed = true;
    session.search = search;
    clearInterval(timer);
    unsubscribe();
    unsubscribeMusic?.();
    input.off("data", onData);
    keyboard.off("keypress", onKey);
    mouse.close();
    keyboard.destroy();
    input.off("end", close);
    output.off("resize", onResize);
    input.setRawMode?.(wasRaw);
    if (!wasFlowing) input.pause();
    for (const [level, method] of original) consoleTarget[level] = method;
    output.write(`${disableMouse}\x1b[?25h\x1b[?1049l`);
  }
  input.once("end", close);
  return { close };
}
