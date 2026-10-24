/** @file Attach the existing dashboard to a daemon without creating messenger clients. */
import { createTui } from "./tui.ts";
import { createTerminalSession } from "./session.ts";
import { controlRequest, type ControlSnapshot } from "../../runtime/control.ts";
import type { Assistant, TerminalState } from "../../types.ts";
import type { MusicStatus } from "../../core/music/status.ts";

/** Run until detached or disconnected; quitting restores the terminal and leaves the daemon running. */
export async function attachTerminal(socket: string) {
  if (!process.stdin.isTTY || !process.stdout.isTTY)
    throw new Error("The tui command requires a terminal.");
  let snapshot: ControlSnapshot = await controlRequest(socket, "/snapshot");
  const session = createTerminalSession();
  session.logs.push(...snapshot.logs);
  const listeners = new Set<(state: TerminalState) => void>();
  const musicListeners = new Set<(state: MusicStatus[]) => void>();
  let failure: unknown;
  let finish!: () => void;
  const done = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const command = (path: string) => controlRequest(socket, path, "POST");
  const assistant: Pick<
    Assistant,
    "subscribeTerminal" | "repliesPaused" | "setRepliesPaused" | "stopCurrentGeneration"
  > = {
    subscribeTerminal(listener) {
      listeners.add(listener);
      listener(snapshot.state);
      return () => listeners.delete(listener);
    },
    repliesPaused: () => snapshot.paused,
    setRepliesPaused(paused) {
      void command(paused ? "/pause" : "/resume").catch((error) => {
        failure = error;
        finish();
      });
    },
    stopCurrentGeneration() {
      void command("/stop").catch((error) => {
        failure = error;
        finish();
      });
      return Boolean(snapshot.state.current);
    },
  };
  const tui = createTui({
    assistant,
    session,
    statistics: { snapshot: () => snapshot.statistics },
    music: {
      subscribe(listener) {
        musicListeners.add(listener);
        listener(snapshot.music);
        return () => musicListeners.delete(listener);
      },
    },
    onRestart: async () => {
      await command("/restart");
    },
    onInterrupt: finish,
  });
  const abort = () => finish();
  process.once("SIGTERM", abort);
  process.once("SIGINT", abort);
  process.stdin.once("end", abort);
  let polling = false;
  const timer = setInterval(async () => {
    if (polling) return;
    polling = true;
    try {
      snapshot = await controlRequest(socket, "/snapshot");
      session.logs.splice(0, session.logs.length, ...snapshot.logs);
      for (const listener of listeners) listener(snapshot.state);
      for (const listener of musicListeners) listener(snapshot.music);
    } catch (error) {
      failure = error;
      finish();
    } finally {
      polling = false;
    }
  }, 200);
  await done;
  clearInterval(timer);
  tui.close();
  process.off("SIGTERM", abort);
  process.off("SIGINT", abort);
  process.stdin.off("end", abort);
  if (failure) throw new Error(`Disconnected from service: ${String(failure)}`);
}
