import { describe, expect, test } from "bun:test";
import { readdir } from "node:fs/promises";
import {
  createVideoDescriptionStore,
  type VideoDescription,
} from "../../src/core/memory/video-descriptions.ts";
import { temporaryDirectory } from "../support/temp.ts";

function entry(id: number, extra: Partial<VideoDescription> = {}): VideoDescription {
  return {
    messageId: String(id),
    kind: "video_note",
    author: "Alice",
    at: "2026-01-01T00:00:00.000Z",
    description: `video ${id}`,
    model: "SmolVLM2",
    ...extra,
  };
}

describe("video description store", () => {
  test("round trips and lists newest first", async () => {
    const store = createVideoDescriptionStore(await temporaryDirectory("vd-"));
    await store.save("c", entry(1, { durationSec: 5 }));
    await store.save("c", entry(2));
    expect(await store.get("c", "1")).toEqual(entry(1, { durationSec: 5 }));
    expect(await store.get("c", "9")).toBeNull();
    expect((await store.list("c", 1)).map((item) => item.messageId)).toEqual(["2"]);
    expect((await store.list("c", 10)).map((item) => item.messageId)).toEqual(["2", "1"]);
  });

  test("upserts by message id and truncates descriptions", async () => {
    const store = createVideoDescriptionStore(await temporaryDirectory("vd-"));
    await store.save("c", entry(1));
    const saved = await store.save("c", entry(1, { description: "x".repeat(3000) }));
    expect(saved.description).toHaveLength(2000);
    expect(await store.list("c", 10)).toHaveLength(1);
  });

  test("keeps only the newest 100 entries", async () => {
    const store = createVideoDescriptionStore(await temporaryDirectory("vd-"));
    for (let id = 1; id <= 105; id++) await store.save("c", entry(id));
    const all = await store.list("c", 200);
    expect(all).toHaveLength(100);
    expect(all[0].messageId).toBe("105");
    expect(await store.get("c", "5")).toBeNull();
    expect(await store.get("c", "6")).not.toBeNull();
  });

  test("finds entries by file unique id", async () => {
    const store = createVideoDescriptionStore(await temporaryDirectory("vd-"));
    await store.save("c", entry(1, { fileUniqueId: "u1" }));
    expect((await store.findByFile("c", "u1"))?.messageId).toBe("1");
    expect(await store.findByFile("c", "nope")).toBeNull();
    expect(await store.findByFile("other", "u1")).toBeNull();
  });

  test("unsafe chat ids stay inside the directory", async () => {
    const directory = await temporaryDirectory("vd-");
    const store = createVideoDescriptionStore(directory);
    await store.save("../../evil/chat:1", entry(1));
    expect(await readdir(directory)).toEqual(["______evil_chat_1.json"]);
    expect(await store.get("../../evil/chat:1", "1")).not.toBeNull();
  });

  test("concurrent saves keep all entries", async () => {
    const store = createVideoDescriptionStore(await temporaryDirectory("vd-"));
    await Promise.all(Array.from({ length: 20 }, (_, index) => store.save("c", entry(index))));
    expect(await store.list("c", 100)).toHaveLength(20);
  });

  test("a corrupt file reads as empty", async () => {
    const directory = await temporaryDirectory("vd-");
    await Bun.write(`${directory}/c.json`, "{not json");
    const store = createVideoDescriptionStore(directory);
    const original = console.error;
    console.error = () => {};
    try {
      expect(await store.list("c", 10)).toEqual([]);
      expect(await store.get("c", "1")).toBeNull();
      await store.save("c", entry(1));
      expect(await store.list("c", 10)).toHaveLength(1);
    } finally {
      console.error = original;
    }
  });
});
