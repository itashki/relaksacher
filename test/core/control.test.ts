/** @file Exercise the real Unix-socket boundary and operator controls without messenger clients. */
import { test, expect } from "bun:test";
import { stat } from "node:fs/promises";
import { createControlServer, controlRequest } from "../../src/runtime/control.ts";
import { createStatistics } from "../../src/core/statistics.ts";
import { createMusicMonitor } from "../../src/core/music/status.ts";
import { fixture } from "../support/fixtures.ts";
import type { Assistant } from "../../src/types.ts";

test("private socket replays telemetry and controls the live assistant", async () => {
  const socket = `/tmp/relaksacher-test-${crypto.randomUUID()}.sock`;
  let paused = false;
  let stops = 0;
  let restarts = 0;
  let subscribed = true;
  const server = await createControlServer({
    socket,
    assistant: fixture<Assistant>({
      subscribeTerminal(listener) {
        listener({ current: null, queue: [] });
        return () => {
          subscribed = false;
        };
      },
      repliesPaused: () => paused,
      setRepliesPaused(value) {
        paused = value;
      },
      stopCurrentGeneration() {
        stops++;
        return true;
      },
    }),
    music: createMusicMonitor(),
    statistics: createStatistics(() => 123),
    restart: async () => {
      restarts++;
    },
  });
  try {
    expect((await stat(socket)).mode & 0o777).toBe(0o600);
    expect((await controlRequest(socket, "/snapshot")).statistics.uptimeMs).toBe(123);
    await controlRequest(socket, "/pause", "POST");
    expect((await controlRequest(socket, "/snapshot")).paused).toBe(true);
    await controlRequest(socket, "/resume", "POST");
    expect(paused).toBe(false);
    expect(await controlRequest(socket, "/stop", "POST")).toBe(true);
    await controlRequest(socket, "/restart", "POST");
    expect(stops).toBe(1);
    expect(restarts).toBe(1);
    await expect(controlRequest(socket, "/stop")).rejects.toThrow("Not found");
    await expect(
      createControlServer({
        socket,
        assistant: fixture<Assistant>({}),
        music: createMusicMonitor(),
        statistics: createStatistics(),
        restart: async () => {},
      }),
    ).rejects.toThrow();
    expect((await controlRequest(socket, "/snapshot")).paused).toBe(false);
  } finally {
    await server.close();
  }
  expect(subscribed).toBe(false);
  await expect(controlRequest(socket, "/snapshot")).rejects.toThrow();
});
