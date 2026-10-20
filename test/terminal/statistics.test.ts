/** @file Uptime formatting, bounded telemetry layout and idle dashboard refresh lifecycle. */
import { expect, test, onTestFinished } from "bun:test";
import { PassThrough } from "node:stream";
import { createStatistics } from "../../src/core/statistics.ts";
import { formatUptime } from "../../src/adapters/terminal/statistics.ts";
import { buildDashboard } from "../../src/adapters/terminal/tui.ts";
import { createTui } from "../support/fixtures.ts";

test("uptime preserves elapsed days and zero-pads clock fields", () => {
  expect(formatUptime(0)).toBe("00:00:00");
  expect(formatUptime(999)).toBe("00:00:00");
  expect(formatUptime(3661000)).toBe("01:01:01");
  expect(formatUptime(90061000)).toBe("1д 01:01:01");
});

test("dashboard wraps per-feature counts and keeps panel regions within resized screens", () => {
  const statistics = createStatistics(() => 90061000);
  statistics.record("model");
  statistics.record("roll");
  for (const [columns, rows] of [
    [100, 30],
    [40, 18],
    [20, 8],
    [2, 2],
  ]) {
    const { screen, regions } = buildDashboard(
      { current: null, queue: [] },
      { columns, rows, statistics: statistics.snapshot() },
    );
    const lines = screen.split("\r\n");
    expect(lines).toHaveLength(rows);
    expect(lines.every((line) => Bun.stringWidth(line) < columns)).toBe(true);
    expect(regions.every((region) => region.y + region.height - 1 <= rows)).toBe(true);
    if (columns >= 40) {
      expect(screen).toContain("Аптайм: 1д 01:01:01");
      expect(screen).toContain("Запросы: 2");
      for (const label of [
        "Модель: 1",
        "Кубы: 1",
        "Музыка: 0",
        "Голос: 0",
        "Озвучка: 0",
        "Расшифровка: 0",
        "Доступ: 0",
      ])
        expect(screen.replace(/\r\n/gu, "")).toContain(label);
    }
  }
});

test("idle TUI refreshes uptime and counters and stops redrawing after close", async () => {
  let now = 0;
  const statistics = createStatistics(() => now);
  const input = new PassThrough();
  const output = Object.assign(new PassThrough(), { columns: 100, rows: 30 });
  let rendered = "";
  output.on("data", (chunk) => {
    rendered += chunk.toString();
  });
  const target = { log() {}, info() {}, warn() {}, error() {}, debug() {} };
  const ui = createTui({
    input,
    output,
    statistics,
    consoleTarget: target,
    assistant: {
      subscribeTerminal(listener) {
        listener({ current: null, queue: [] });
        return () => {};
      },
    },
  });
  onTestFinished(() => {
    ui.close();
    input.destroy();
    output.destroy();
  });
  expect(rendered).toContain("00:00:00");
  now = 2000;
  statistics.record("roll");
  await Bun.sleep(110);
  expect(rendered).toContain("00:00:02");
  expect(rendered).toContain("Запросы: 1");
  expect(rendered).toContain("Кубы: 1");
  ui.close();
  const closed = rendered;
  now = 5000;
  statistics.record("model");
  await Bun.sleep(110);
  expect(rendered).toBe(closed);
});
