/** @file Scroll anchoring, viewport boundaries and panel selection behavior. */
import { expect, test } from "bun:test";
import {
  createNavigation,
  scrollPanel,
  selectPanel,
  visibleLines,
  panelOrder,
} from "../src/adapters/tui-scroll.ts";
import { buildDashboard } from "../src/adapters/tui.ts";

const lines = Array.from({ length: 80 }, (_, i) => `ROW-${String(i).padStart(3, "0")}`);

test("scrollback anchors existing lines while tail follows appended output", () => {
  const navigation = createNavigation();
  const initial = visibleLines(lines, 10, navigation.positions.answer);
  expect(initial.lines).toEqual(lines.slice(-10));
  scrollPanel(navigation, initial, "pageup");
  const before = visibleLines(lines, 10, navigation.positions.answer);
  const appended = [...lines, "NEW"];
  expect(visibleLines(appended, 10, navigation.positions.answer).lines).toEqual(before.lines);
  scrollPanel(navigation, before, "end");
  expect(visibleLines(appended, 10, navigation.positions.answer).lines.at(-1)).toBe("NEW");
});

test("navigation clamps on resize and data shrink, supports boundaries and independent panels", () => {
  const navigation = createNavigation();
  scrollPanel(navigation, visibleLines(lines, 10, "tail"), "home");
  expect(navigation.positions.answer).toBe(0);
  scrollPanel(navigation, visibleLines(lines, 10, 0), "up");
  expect(navigation.positions.answer).toBe(0);
  scrollPanel(navigation, visibleLines(lines, 10, 0), "pagedown");
  expect(navigation.positions.answer).toBe(9);
  expect(navigation.positions.logs).toBe("tail");
  expect(visibleLines(["one"], 10, 999)).toMatchObject({ lines: ["one"], start: 0 });
  expect(visibleLines(lines, 200, 50).start).toBe(0);
  const available = panelOrder.filter((id) => id !== "music");
  selectPanel(navigation, available, true);
  expect(navigation.selected).toBe("prompt");
  selectPanel(navigation, available);
  expect(navigation.selected).toBe("answer");
  expect(navigation.positions.answer).toBe(9);
});

test("every dashboard section exposes all wrapped content in expanded and compact views", () => {
  const navigation = createNavigation();
  navigation.expanded = true;
  const state = {
    current: {
      id: 1,
      text: lines.join("\n"),
      thinking: lines.join("\n"),
      prompt: lines.join("\n"),
    },
    queue: lines.map((prompt, id) => ({ id, prompt })),
  };
  const music: import("../src/core/music-status.ts").MusicStatus[] = lines.map(
    (guildName, i): import("../src/core/music-status.ts").MusicStatus => ({
      guildId: String(i),
      guildName,
      channelId: null,
      channelName: null,
      status: "stopped" as const,
      current: "",
      saved: 1,
      queued: 0,
      error: "",
      repeat: "off" as const,
      shuffle: false,
    }),
  );
  for (const id of panelOrder) {
    navigation.selected = id;
    navigation.positions[id] = 0;
    const initial = buildDashboard(state, { navigation, logs: lines, music });
    expect(initial.screen).toContain("ROW-000");
    expect(initial.screen).not.toContain("ROW-079");
    scrollPanel(navigation, initial.viewports[id], "end");
    const end = buildDashboard(state, { navigation, logs: lines, music });
    expect(end.screen).toContain("ROW-079");
    expect(end.screen).not.toContain("ROW-000");
    for (const [columns, rows] of [
      [100, 30],
      [40, 18],
      [20, 8],
      [2, 2],
    ]) {
      const screen = buildDashboard(state, {
        navigation,
        logs: lines,
        music,
        columns,
        rows,
      }).screen;
      expect(screen.split("\r\n")).toHaveLength(rows - 1);
      expect(screen.split("\r\n").every((line) => Bun.stringWidth(line) < columns)).toBe(true);
    }
  }
});
