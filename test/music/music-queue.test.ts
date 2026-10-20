/** @file Regression coverage for music queue behavior and its external boundaries. */
import { expect, test } from "bun:test";
import {
  createPlaybackQueue,
  startQueue,
  startQueueAt,
  advanceQueue,
  shuffled,
} from "../../src/core/music/queue.ts";

test("repeat track replays on completion while skip and failure advance", () => {
  const queue = createPlaybackQueue();
  queue.repeat = "track";
  startQueue(queue, ["a", "b", "c"]);
  expect(advanceQueue(queue)).toBe("a");
  expect(advanceQueue(queue)).toBe("a");
  expect(queue.pending).toEqual(["b", "c"]);
  expect(advanceQueue(queue, "skip")).toBe("b");
  expect(advanceQueue(queue, "failed")).toBe("c");
  expect(advanceQueue(queue, "skip")).toBe("");
});

test("repeat all loops the playback selection and stops retrying failed sources", () => {
  const queue = createPlaybackQueue();
  queue.repeat = "all";
  startQueue(queue, ["a", "b"]);
  expect(advanceQueue(queue)).toBe("a");
  expect(advanceQueue(queue)).toBe("b");
  expect(advanceQueue(queue)).toBe("a");
  expect(advanceQueue(queue, "failed")).toBe("b");
  expect(advanceQueue(queue)).toBe("b");
  expect(advanceQueue(queue, "failed")).toBe("");
  expect(advanceQueue(queue)).toBe("");
  startQueue(queue, ["a"]);
  expect(advanceQueue(queue)).toBe("a");
});

test("shuffle preserves occurrences, does not mutate saved order, and repeat off ends", () => {
  const tracks = ["a", "b", "b", "c"];
  expect(shuffled(tracks, () => 0)).toEqual(["b", "b", "c", "a"]);
  expect(tracks).toEqual(["a", "b", "b", "c"]);
  const queue = createPlaybackQueue();
  queue.shuffle = true;
  startQueue(queue, tracks);
  const played: string[] = [];
  while (advanceQueue(queue)) played.push(queue.current);
  expect(played.sort()).toEqual([...tracks].sort());
  expect(queue.cycle).toEqual(tracks);
  expect(queue.current).toBe("");
  expect(queue.pending).toEqual([]);
});

test("failed duplicate tracks are skipped and disabling repeat finishes the remaining queue", () => {
  const queue = createPlaybackQueue();
  queue.repeat = "all";
  startQueue(queue, ["a", "a", "b"]);
  expect(advanceQueue(queue)).toBe("a");
  expect(advanceQueue(queue, "failed")).toBe("b");
  queue.repeat = "off";
  expect(advanceQueue(queue)).toBe("");
});

test("playlist selection replaces playback and keeps selected track first under shuffle", () => {
  const tracks = ["before", "chosen", "later", "chosen", "last"];
  for (const shuffle of [false, true]) {
    const queue = createPlaybackQueue();
    queue.repeat = "track";
    queue.shuffle = shuffle;
    queue.current = "old";
    queue.pending = ["old-next"];
    queue.failedTracks.add("chosen");
    startQueueAt(queue, tracks, 1);
    expect(advanceQueue(queue)).toBe("chosen");
    expect(advanceQueue(queue)).toBe("chosen");
    expect(queue.cycle).toEqual(tracks.slice(1));
    expect([...queue.pending].sort()).toEqual(["later", "chosen", "last"].sort());
    expect(queue.failedTracks.size).toBe(0);
    expect(tracks).toEqual(["before", "chosen", "later", "chosen", "last"]);
    for (const index of [-1, 5, 0.5, NaN])
      expect(() => startQueueAt(queue, tracks, index)).toThrow("Invalid track index");
  }
});
