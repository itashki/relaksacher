/** @file Private Unix-socket operator API shared by the daemon and attached dashboards. */
import { chmod } from "node:fs/promises";
import type { Assistant, TerminalState } from "../types.ts";
import type { MusicStatus, MusicStatusSource } from "../core/music/status.ts";
import type { RequestStatistics, StatisticsSource } from "../core/statistics.ts";

/** Socket defaults to the login runtime directory; system services set an explicit path. */
export function controlSocket() {
  return (
    Bun.env.RELAKSACHER_SOCKET ||
    `${Bun.env.XDG_RUNTIME_DIR || "/tmp"}/relaksacher-${process.getuid?.() ?? "user"}.sock`
  );
}
export type ControlSnapshot = {
  state: TerminalState;
  music: MusicStatus[];
  statistics: RequestStatistics;
  paused: boolean;
  logs: string[];
};

/** Bind exclusively; an existing socket is never removed or taken over. Socket access grants bot control. */
export async function createControlServer(options: {
  socket: string;
  assistant: Assistant;
  music: MusicStatusSource;
  statistics: StatisticsSource;
  restart: () => Promise<void>;
}) {
  let state: TerminalState = { current: null, queue: [] };
  let music: MusicStatus[] = [];
  const logs: string[] = [];
  const original = new Map<"log" | "info" | "warn" | "error" | "debug", typeof console.log>();
  // Apply before binding so the socket is private from the moment it exists.
  const previousMask = process.umask(0o177);
  let server: ReturnType<typeof Bun.serve>;
  try {
    server = Bun.serve({
      unix: options.socket,
      async fetch(request) {
        const path = new URL(request.url).pathname;
        if (request.method === "GET" && path === "/snapshot")
          return Response.json({
            state,
            music,
            statistics: options.statistics.snapshot(),
            paused: options.assistant.repliesPaused(),
            logs,
          });
        if (request.method !== "POST") return new Response("Not found", { status: 404 });
        if (path === "/stop") return Response.json(options.assistant.stopCurrentGeneration());
        if (path === "/pause" || path === "/resume") {
          options.assistant.setRepliesPaused(path === "/pause");
          return Response.json(true);
        }
        if (path === "/restart") {
          try {
            await options.restart();
            return Response.json(true);
          } catch (error) {
            return new Response(String(error), { status: 500 });
          }
        }
        return new Response("Not found", { status: 404 });
      },
    });
  } finally {
    process.umask(previousMask);
  }
  try {
    await chmod(options.socket, 0o600);
  } catch (error) {
    await server.stop(true);
    throw error;
  }
  const unsubscribe = options.assistant.subscribeTerminal((next) => {
    state = next;
  });
  const unsubscribeMusic = options.music.subscribe((next) => {
    music = next;
  });
  for (const level of ["log", "info", "warn", "error", "debug"] as const) {
    const previous = console[level];
    original.set(level, previous);
    console[level] = (...args) => {
      previous(...args);
      if (args[0] === "[thinking]") return;
      logs.push(
        args
          .map((value) => (typeof value === "string" ? value : Bun.inspect(value)))
          .join(" ")
          .slice(0, 4000),
      );
      if (logs.length > 1000) logs.shift();
    };
  }
  return {
    /** Release subscriptions, restore logging, and unlink the socket owned by Bun. */
    async close() {
      unsubscribe();
      unsubscribeMusic();
      for (const [level, previous] of original) console[level] = previous;
      await server.stop(true);
    },
  };
}

/** Make a bounded local request; the Unix socket never exposes a TCP listener. */
export async function controlRequest(socket: string, path: string, method = "GET") {
  const response = await fetch(`http://localhost${path}`, {
    unix: socket,
    method,
    signal: AbortSignal.timeout(path === "/restart" ? 3600000 : 5000),
  });
  if (!response.ok) throw new Error(await response.text());
  return response.json();
}
