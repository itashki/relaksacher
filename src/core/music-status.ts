/** @file Publish read-only music snapshots to terminal subscribers without exposing player controls. */
/** Read-only music telemetry shared by the Discord adapter and terminal UI. */
export type MusicStatus = {
  guildId: string;
  guildName: string;
  channelId: string | null;
  channelName: string | null;
  status: "stopped" | "connecting" | "buffering" | "playing" | "paused" | "idle" | "importing";
  current: string;
  saved: number;
  queued: number;
  error: string;
  repeat: import("./music-queue.ts").RepeatMode;
  shuffle: boolean;
};
/** Read-only subscription; subscribers immediately receive the latest snapshot. */
export type MusicStatusSource = {
  subscribe: (listener: (statuses: MusicStatus[]) => void) => () => void;
};

/** Create a replaying subscription source; copy snapshots so listeners cannot mutate shared telemetry. */
export function createMusicMonitor(): MusicStatusSource & {
  publish: (statuses: MusicStatus[]) => void;
} {
  let latest: MusicStatus[] = [];
  const listeners = new Set<(statuses: MusicStatus[]) => void>();
  const snapshot = () => latest.map((status) => ({ ...status }));
  return {
    publish(statuses) {
      latest = statuses.map((status) => ({ ...status }));
      for (const listener of listeners) listener(snapshot());
    },
    subscribe(listener) {
      listeners.add(listener);
      listener(snapshot());
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
