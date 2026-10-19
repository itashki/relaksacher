/** @file Independent panel selection and line-based viewport navigation for the TUI. */
/** Keyboard traversal order; unavailable music panels are skipped. */
export const panelOrder = ["answer", "thinking", "logs", "queue", "music", "prompt"] as const;
/** Scrollable operator sections, including the full current request. */
export type PanelId = (typeof panelOrder)[number];
/** Numeric positions stay anchored as content arrives; tail follows the newest lines. */
export type ScrollPosition = number | "tail";
/** Wrapped-line geometry for the most recent render of a panel. */
export type Viewport = { start: number; total: number; rows: number };
/** Focus, expansion mode and a separate scroll position for each section. */
export type Navigation = {
  expanded: boolean;
  selected: PanelId;
  positions: Record<PanelId, ScrollPosition>;
};

/** Create independent scroll positions; lists start at the beginning, streams at the end. */
export function createNavigation(): Navigation {
  return {
    expanded: false,
    selected: "answer",
    positions: { answer: "tail", thinking: "tail", logs: "tail", queue: 0, music: 0, prompt: 0 },
  };
}

/** Clamp a viewport after content changes or terminal resizing without mutating its source. */
export function visibleLines(lines: string[], rows: number, position: ScrollPosition) {
  const count = Math.max(1, rows);
  const max = Math.max(0, lines.length - count);
  const start = position === "tail" ? max : Math.min(max, Math.max(0, position));
  return { lines: lines.slice(start, start + count), start, total: lines.length, rows: count };
}

/** Scroll the selected viewport; reaching End or the bottom resumes following new output. */
export function scrollPanel(
  navigation: Navigation,
  viewport: Viewport | undefined,
  key: string,
  step = 1,
) {
  if (!viewport) return;
  const max = Math.max(0, viewport.total - viewport.rows);
  if (key === "home") navigation.positions[navigation.selected] = 0;
  else if (key === "end") navigation.positions[navigation.selected] = "tail";
  else {
    const amount =
      key === "pageup" || key === "pagedown" ? Math.max(1, viewport.rows - 1) : Math.max(1, step);
    const next = Math.max(
      0,
      Math.min(max, viewport.start + (key === "up" || key === "pageup" ? -amount : amount)),
    );
    navigation.positions[navigation.selected] = next >= max ? "tail" : next;
  }
}

/** Cycle only available panels, including backwards navigation with Shift+Tab. */
export function selectPanel(navigation: Navigation, available: PanelId[], backwards = false) {
  const index = available.indexOf(navigation.selected);
  navigation.selected =
    available[(index + (backwards ? -1 : 1) + available.length) % available.length] ?? "answer";
}
