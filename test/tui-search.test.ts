/** @file Literal panel search, soft-wrap highlights and bounded result navigation. */
import { expect, test } from "bun:test";
import { createSearch, searchLines, searchIndex } from "../src/adapters/tui-search.ts";
import { createNavigation, panelOrder } from "../src/adapters/tui-scroll.ts";
import { buildDashboard } from "../src/adapters/tui.ts";

test("search is literal and case-insensitive, including Unicode and regex metacharacters", () => {
  expect(searchLines(["ПрИвЕт привет", "other"], "привет", (line) => [line]).matches).toHaveLength(
    2,
  );
  expect(searchLines(["a.b axb [x]"], "a.b", (line) => [line]).matches).toHaveLength(1);
  expect(searchLines(["a.b axb [x]"], "[x]", (line) => [line]).matches).toHaveLength(1);
  expect(searchLines(["any"], "", (line) => [line]).matches).toHaveLength(0);
  expect(searchLines(["hello", "world"], "helloworld", (line) => [line]).matches).toHaveLength(0);
});

test("a search match crosses soft wraps and maps highlights to both rendered rows", () => {
  const result = searchLines(["abcdefgh"], "def", (line) => [line.slice(0, 4), line.slice(4)]);
  expect(result.matches).toEqual([{ row: 0 }]);
  expect(result.spans).toEqual({
    0: [{ start: 3, end: 4, match: 0 }],
    1: [{ start: 0, end: 2, match: 0 }],
  });
  expect(searchIndex(0, 2, "previous")).toBe(1);
  expect(searchIndex(1, 2, "next")).toBe(0);
  expect(searchIndex(9, 2)).toBe(1);
  expect(searchIndex(0, 0, "next")).toBe(-1);
});

test("search jumps and highlights in all panels, preserving dimensions and source sanitization", () => {
  const values = Array.from({ length: 80 }, (_, i) =>
    i === 4 || i === 59 ? "MATCH" : `line-${i}`,
  );
  const state = {
    current: {
      id: 1,
      text: values.join("\n"),
      thinking: values.join("\n"),
      prompt: values.join("\n"),
    },
    queue: values.map((prompt, id) => ({ id, prompt })),
  };
  const music: import("../src/core/music-status.ts").MusicStatus[] = values.map(
    (guildName, i): import("../src/core/music-status.ts").MusicStatus => ({
      guildId: String(i),
      guildName,
      channelId: null,
      channelName: null,
      status: "stopped",
      current: "",
      saved: 0,
      queued: 0,
      error: "",
      repeat: "off",
      shuffle: false,
    }),
  );
  for (const panel of panelOrder) {
    const navigation = createNavigation();
    navigation.expanded = true;
    navigation.selected = panel;
    const search = { ...createSearch(), panel, query: "match" };
    const first = buildDashboard(state, {
      navigation,
      search,
      searchMove: "first",
      logs: values,
      music,
      color: true,
    });
    expect(first.searchResult.total).toBe(2);
    expect(first.searchResult.index).toBe(0);
    expect(first.screen).toContain("\x1b[1;30;43mMATCH\x1b[0m");
    search.match = 0;
    const next = buildDashboard(state, {
      navigation,
      search,
      searchMove: "next",
      logs: values,
      music,
    });
    expect(next.searchResult.index).toBe(1);
    expect(next.viewports[panel].start).toBeGreaterThan(first.viewports[panel].start);
    for (const [columns, rows] of [
      [100, 30],
      [40, 12],
      [2, 2],
    ]) {
      const screen = buildDashboard(state, {
        navigation,
        search,
        searchMove: "first",
        logs: values,
        music,
        columns,
        rows,
        color: true,
      }).screen;
      expect(screen.split("\r\n")).toHaveLength(rows);
      expect(screen.split("\r\n").every((line) => Bun.stringWidth(line) < columns)).toBe(true);
    }
  }
  expect(
    buildDashboard(state, { search: { ...createSearch(), panel: "answer", query: "absent" } })
      .screen,
  ).toContain("нет совпадений");
});
