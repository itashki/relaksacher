/** @file Manage playback selection, repeat modes, shuffle order and failed-track exclusion. */
/** Playback ordering is separate from the persistent playlist and voice transport. */
/** Repeat only natural track completion, cycle the selection, or stop at its end. */
export type RepeatMode = "off" | "track" | "all";
/** Distinguish natural completion from explicit skips and broken sources. */
export type AdvanceReason = "finished" | "skip" | "failed";
/** Return a Fisher–Yates permutation without changing the input or dropping duplicate entries. */
export function shuffled<T>(items: readonly T[], random = Math.random): T[] {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}
/** Create a stopped queue with repeat and shuffle disabled; settings remain independent of saved tracks. */
export function createPlaybackQueue() {
  return {
    repeat: "off" as RepeatMode,
    shuffle: false,
    current: "",
    pending: [] as string[],
    cycle: [] as string[],
    failedTracks: new Set<string>(),
  };
}
type Queue = ReturnType<typeof createPlaybackQueue>;
/** Snapshot a new playback selection, clear failed tracks and apply the current shuffle preference. */
export function startQueue(queue: Queue, tracks: string[]) {
  queue.current = "";
  queue.cycle = [...tracks];
  queue.failedTracks.clear();
  queue.pending = queue.shuffle ? shuffled(tracks) : [...tracks];
}
/** Choose the next track, repeating only on natural completion in track mode.
 * Failed URLs are excluded until the next start; repeat-all uses the original playback selection.
 * @returns The next URL, or an empty string when no playable entries remain. */
export function advanceQueue(queue: Queue, reason: AdvanceReason = "finished"): string {
  if (reason === "failed" && queue.current) queue.failedTracks.add(queue.current);
  if (reason === "finished" && queue.repeat === "track" && queue.current) return queue.current;
  queue.pending = queue.pending.filter((track) => !queue.failedTracks.has(track));
  if (!queue.pending.length && queue.repeat === "all") {
    const available = queue.cycle.filter((track) => !queue.failedTracks.has(track));
    queue.pending = queue.shuffle ? shuffled(available) : [...available];
  }
  queue.current = queue.pending.shift() ?? "";
  return queue.current;
}
