/** @file Application shutdown with live handles, stalled cleanup and real terminal interrupts. */
import { expect, test, onTestFinished } from "bun:test";
import { createShutdown } from "../src/core/shutdown.ts";

test("shutdown invokes every cleanup once and waits for completion", async () => {
  let release: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  const calls: string[] = [];
  const exits: number[] = [];
  const shutdown = createShutdown({
    steps: [
      () => {
        calls.push("ui");
      },
      () => {
        calls.push("adapter");
        return pending;
      },
      () => {
        calls.push("model");
      },
    ],
    exit: (code) => {
      exits.push(code);
    },
  });
  expect(shutdown.started).toBe(false);
  const done = shutdown.run(1);
  expect(shutdown.run(0)).toBe(done);
  expect(shutdown.started).toBe(true);
  expect(calls).toEqual(["ui", "adapter", "model"]);
  expect(exits).toEqual([]);
  release();
  await done;
  expect(exits).toEqual([1]);
});

test("cleanup failures do not prevent other adapters stopping or leave a rejected shutdown", async () => {
  const calls: string[] = [],
    reports: unknown[] = [],
    exits: number[] = [];
  const shutdown = createShutdown({
    steps: [
      () => {
        throw new Error("sync failure");
      },
      () => Promise.reject(new Error("async failure")),
      () => {
        calls.push("other adapter stopped");
      },
    ],
    exit: (code) => {
      exits.push(code);
    },
    report: (_message, error) => {
      reports.push(error);
    },
  });
  await shutdown.run();
  expect(calls).toEqual(["other adapter stopped"]);
  expect(reports).toHaveLength(2);
  expect(exits).toEqual([0]);
});

test("stalled cleanup exits at the deadline, once, even if cleanup later completes", async () => {
  let release: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  const reports: string[] = [],
    exits: number[] = [];
  const shutdown = createShutdown({
    steps: [() => pending],
    timeoutMs: 30,
    exit: (code) => {
      exits.push(code);
    },
    report: (message) => {
      reports.push(message);
    },
  });
  await shutdown.run();
  expect(exits).toEqual([0]);
  expect(reports[0]).toContain("deadline");
  release();
  await Bun.sleep(10);
  await shutdown.run();
  expect(exits).toEqual([0]);
});

for (const stalled of [false, true]) {
  test(`one Ctrl+C exits the application with an open HTTP server${stalled ? " and stalled adapter" : ""}`, async () => {
    const shutdownModule = Bun.resolveSync("../src/core/shutdown.ts", import.meta.dir);
    const tuiModule = Bun.resolveSync("../src/adapters/tui.ts", import.meta.dir);
    const script = `
      import { createShutdown } from ${JSON.stringify(shutdownModule)};
      import { createTui } from ${JSON.stringify(tuiModule)};
      // Leave this handle open to reproduce a real client/socket leak.
      const server = Bun.serve({ port: 0, fetch() { return new Response("ok"); } });
      const audio = Bun.spawn([Bun.argv[0], "-e", "setInterval(() => {}, 1000)"], { stdout: "ignore", stderr: "ignore" });
      const shutdown = createShutdown({ timeoutMs: 120, steps: [
        () => ui.close(),
        () => { audio.kill("SIGKILL"); return audio.exited; },
        () => ${stalled ? "new Promise(() => {})" : "Promise.resolve()"},
      ] });
      const ui = createTui({ assistant: {
        subscribeTerminal(listener) { listener({ current: null, queue: [] }); return () => {}; },
        stopCurrentGeneration() { return false; },
      } });
      process.on("SIGINT", () => { void shutdown.run(); });
      await Bun.write(Bun.stdout, "READY");
    `;
    let rendered = "";
    const child = Bun.spawn([Bun.argv[0], "-e", script], {
      terminal: {
        cols: 100,
        rows: 30,
        data(_terminal, data) {
          rendered += new TextDecoder().decode(data);
        },
      },
    });
    onTestFinished(async () => {
      child.kill();
      await child.exited;
      child.terminal.close();
    });
    for (let i = 0; i < 200 && !rendered.includes("READY"); i++) await Bun.sleep(10);
    expect(rendered).toContain("READY");
    const before = Date.now();
    child.terminal.write("\x03");
    expect(await Promise.race([child.exited, Bun.sleep(1000).then(() => "still running")])).toBe(0);
    expect(Date.now() - before).toBeLessThan(1000);
    expect(rendered).toContain("\x1b[?25h\x1b[?1049l");
    if (stalled) expect(rendered).toContain("Shutdown deadline reached");
    else expect(rendered).not.toContain("Shutdown deadline reached");
  });
}
