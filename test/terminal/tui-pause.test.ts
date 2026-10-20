/** @file Pause control handles keyboard and mouse without consuming search text. */
import { expect, test } from "bun:test";
import { PassThrough } from "node:stream";
import { buildDashboard, createTui } from "../../src/adapters/terminal/tui.ts";
import { setup } from "../support/assistant-fixture.ts";

test("P pauses, header click resumes, and search input leaves pause unchanged", async () => {
  const { assistant } = setup([]);
  const input = new PassThrough();
  const output = Object.assign(new PassThrough(), { columns: 100, rows: 30 });
  output.resume();
  const ui = createTui({
    assistant,
    input,
    output,
    consoleTarget: { log() {}, info() {}, warn() {}, error() {}, debug() {} } as Console,
  });
  try {
    input.write("P");
    expect(assistant.repliesPaused()).toBe(true);
    const { pauseRegion, screen } = buildDashboard(
      { current: null, queue: [] },
      { repliesPaused: true, columns: 100 },
    );
    expect(screen).toContain("[P Включить ИИ]");
    input.write(`\x1b[<0;${pauseRegion.x};1M`);
    expect(assistant.repliesPaused()).toBe(false);
    input.write("/pP");
    expect(assistant.repliesPaused()).toBe(false);
  } finally {
    ui.close();
    input.destroy();
    output.destroy();
  }
});
