/** @file Restart button/hotkey integration with real terminal decoding and async status updates. */
import { expect, test } from "bun:test";
import { PassThrough } from "node:stream";
import { createTui, buildDashboard } from "../../src/adapters/terminal/tui.ts";
import { fixture } from "../support/fixtures.ts";
import type { Assistant } from "../../src/types.ts";

test("restart hit regions remain on the visible header after resizing", () => {
  for (const [columns, rows] of [
    [100, 30],
    [20, 8],
    [2, 2],
  ]) {
    const { screen, restartRegion } = buildDashboard(
      { current: null, queue: [] },
      {
        columns,
        rows,
        restarting: false,
      },
    );
    expect(screen.split("\r\n")).toHaveLength(rows);
    expect(screen.split("\r\n").every((line) => Bun.stringWidth(line) < columns)).toBe(true);
    expect(restartRegion.y).toBe(1);
    expect(restartRegion.x + restartRegion.width).toBe(columns);
  }
});

test("R and header click restart once, search input stays text, and errors allow retry", async () => {
  const input = new PassThrough();
  let screen = "",
    calls = 0,
    stops = 0;
  let pending = Promise.withResolvers<void>();
  const output = Object.assign(new PassThrough(), { columns: 100, rows: 30 });
  output.on("data", (data) => {
    screen = data.toString();
  });
  const ui = createTui({
    input,
    output,
    consoleTarget: { log() {}, info() {}, warn() {}, error() {}, debug() {} } as Console,
    assistant: fixture<Assistant>({
      subscribeTerminal(listener) {
        listener({ current: null, queue: [] });
        return () => {};
      },
      stopCurrentGeneration() {
        stops++;
        return false;
      },
    }),
    onRestart: () => {
      calls++;
      return pending.promise;
    },
  });
  const waitFor = async (condition: () => boolean) => {
    for (let attempt = 0; attempt < 100; attempt++) {
      if (condition()) return;
      await Bun.sleep(10);
    }
    throw new Error(`Expected restart status missing: ${screen}`);
  };
  try {
    expect(screen).toContain("[R Рестарт]");
    input.write("/rR");
    await waitFor(() => screen.includes("/rR█"));
    expect(calls).toBe(0);
    input.write("\x1b");
    await waitFor(() => !screen.includes("/rR█"));
    input.write("R");
    await waitFor(() => screen.includes("[Рестарт…]"));
    input.write("r\x1b[<0;95;1M");
    await Bun.sleep(20);
    expect(calls).toBe(1);
    expect(stops).toBe(0);
    pending.resolve();
    await waitFor(() => screen.includes("Рестарт завершён."));
    pending = Promise.withResolvers<void>();
    input.write("\x1b[<0;95;1M");
    await waitFor(() => calls === 2);
    pending.reject(new Error("broken build"));
    await waitFor(() => screen.includes("broken build"));
    expect(screen).toContain("[R Рестарт]");
    pending = Promise.withResolvers<void>();
    input.write("r");
    await waitFor(() => calls === 3);
    ui.close();
    pending.resolve();
    await Bun.sleep(100);
    expect(screen).toContain("\x1b[?1049l");
  } finally {
    ui.close();
    input.destroy();
    output.destroy();
  }
});
