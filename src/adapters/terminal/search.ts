/** @file Literal Unicode search across logical panel lines and soft terminal wraps. */
import type { PanelId, ScrollPosition } from "./scroll.ts";

/** Search input and the selected occurrence belong to one panel at a time. */
export type SearchState = {
  panel: PanelId | null;
  query: string;
  editing: boolean;
  match: number;
  savedPosition: ScrollPosition;
};
/** Requested jump, separate from ordinary live redraws which must not move the viewport. */
export type SearchMove = "first" | "next" | "previous";
/** Highlight offsets use UTF-16 indexes in the plain rendered row. */
export type SearchSpan = { start: number; end: number; match: number };

/** Create an inactive search without changing the panel's scroll position. */
export function createSearch(): SearchState {
  return { panel: null, query: "", editing: false, match: -1, savedPosition: "tail" };
}

/**
 * Find case-insensitive literal occurrences before soft wrapping, then map them
 * to visible rows. Matches may cross a soft wrap, but never a logical newline.
 * Input must already be plain sanitized text; query characters are regex-escaped.
 */
export function searchLines(
  logicalLines: string[],
  query: string,
  wrap: (line: string) => string[],
) {
  const lines: string[] = [];
  const matches: { row: number }[] = [];
  const spans: Record<number, SearchSpan[]> = {};
  const pattern = query ? new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "giu") : null;
  for (const line of logicalLines) {
    const base = lines.length;
    const parts = wrap(line);
    lines.push(...parts);
    if (!pattern) continue;
    for (const match of line.matchAll(pattern)) {
      const start = match.index,
        end = start + match[0].length;
      const index = matches.length;
      let offset = 0,
        first = -1;
      for (let row = 0; row < parts.length; row++) {
        const partEnd = offset + parts[row].length;
        if (start < partEnd && end > offset) {
          if (first < 0) first = base + row;
          (spans[base + row] ??= []).push({
            start: Math.max(0, start - offset),
            end: Math.min(parts[row].length, end - offset),
            match: index,
          });
        }
        offset = partEnd;
      }
      if (first >= 0) matches.push({ row: first });
    }
  }
  return { lines, matches, spans };
}

/** Cycle match indexes in either direction, including after content shrinks. */
export function searchIndex(current: number, total: number, move?: SearchMove) {
  if (!total) return -1;
  if (move === "first" || current < 0) return move === "previous" ? total - 1 : 0;
  if (!move) return Math.min(current, total - 1);
  return (Math.min(current, total - 1) + (move === "next" ? 1 : -1) + total) % total;
}

/** Insert terminal styling into already sanitized text; measurements still use the plain row. */
export function highlightMatches(line: string, spans: SearchSpan[] = [], active: number) {
  let offset = 0,
    result = "";
  for (const span of spans) {
    if (span.start >= line.length) break;
    result +=
      line.slice(offset, span.start) +
      `\x1b[${span.match === active ? "1;30;43" : "30;43"}m` +
      line.slice(span.start, span.end) +
      "\x1b[0m";
    offset = Math.min(line.length, span.end);
  }
  return result + line.slice(offset);
}
