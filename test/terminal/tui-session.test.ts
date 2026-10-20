/** @file Terminal replacement preserves operator state and releases subscriptions and raw input. */
import { expect, test } from "bun:test";
import { PassThrough } from "node:stream";
import { createTui } from "../support/fixtures.ts";
import { createTerminalSession } from "../../src/adapters/terminal/session.ts";
import { createStatistics } from "../../src/core/statistics.ts";

test("replacement reuses logs, navigation, search and counters with one active subscription", async () => {
  const input = Object.assign(new PassThrough(), {
    isRaw: false,
    setRawMode(mode: boolean) {
      this.isRaw = mode;
    },
  });
  const output = Object.assign(new PassThrough(), { columns: 100, rows: 30 });
  let screen = "";
  output.on("data", (data) => {
    screen = data.toString();
  });
  let subscriptions = 0;
  const assistant = {
    subscribeTerminal(listener: (state: { current: null; queue: [] }) => void) {
      subscriptions++;
      listener({ current: null, queue: [] });
      return () => {
        subscriptions--;
      };
    },
  };
  const statistics = createStatistics(() => 10000);
  statistics.record("roll");
  const session = createTerminalSession();
  const target = { log(..._args: unknown[]) {}, info() {}, warn() {}, error() {}, debug() {} };
  const original = target.log;
  const options = { input, output, assistant, statistics, session, consoleTarget: target };
  const first = createTui(options);
  target.log("retained operator log");
  input.write("h");
  input.write("/");
  input.write("retained");
  first.close();
  expect(subscriptions).toBe(0);
  expect(input.isRaw).toBe(false);
  expect(target.log).toBe(original);
  expect(session.search.query).toBe("retained");
  expect(session.navigation.selected).toBe("thinking");
  expect(session.logs).toEqual(["retained operator log"]);
  const second = createTui(options);
  try {
    expect(subscriptions).toBe(1);
    expect(input.isRaw).toBe(true);
    expect(screen).toContain("00:00:10");
    expect(screen).toContain("Кубы: 1");
    expect(screen).toContain("/retained");
    target.log("second generation");
    expect(session.logs).toEqual(["retained operator log", "second generation"]);
  } finally {
    second.close();
    input.destroy();
    output.destroy();
  }
  expect(subscriptions).toBe(0);
  expect(input.isRaw).toBe(false);
  expect(target.log).toBe(original);
});
