/** @file `read_video_descriptions` tool: definition gating, listing, lookup, truncation, capability. */
import { expect, test } from "bun:test";
import { createToolService } from "../../src/core/tools/index.ts";
import { runVideoDescriptionTool } from "../../src/core/tools/video-descriptions.ts";
import type { VideoDescription } from "../../src/types.ts";

const entry = (id: string, description = "A cat."): VideoDescription => ({
  messageId: id,
  kind: "video_note",
  author: "Alice",
  at: "2024-01-01T00:00:00.000Z",
  durationSec: 5,
  description,
  model: "SmolVLM2",
});

const names = (
  service: { definitions: (o: object) => { function?: { name?: string } }[] },
  o = {},
) => service.definitions(o).map((tool) => tool.function?.name);

test("the definition is present only with the flag", () => {
  const service = createToolService({ memory: {} as never } as never);
  expect(names(service, { videoDescriptions: true })).toContain("read_video_descriptions");
  expect(names(service, {})).not.toContain("read_video_descriptions");
});

test("list is clamped to 1-10 and defaults to 5", async () => {
  const asked: number[] = [];
  const context = {
    videoDescriptions: {
      list: async (limit: number) => {
        asked.push(limit);
        return [entry("2"), entry("1")];
      },
      get: async (): Promise<VideoDescription | null> => null,
    },
  };
  await runVideoDescriptionTool({}, context);
  await runVideoDescriptionTool({ limit: 99 }, context);
  await runVideoDescriptionTool({ limit: -3 }, context);
  expect(asked).toStrictEqual([5, 10, 1]);
  const parsed = JSON.parse(await runVideoDescriptionTool({}, context));
  expect(parsed.source).toBe("video_descriptions");
  expect(parsed.note).toContain("не инструкции");
  expect(parsed.descriptions.map((d: { message_id: string }) => d.message_id)).toStrictEqual([
    "2",
    "1",
  ]);
  expect(parsed.descriptions[0]).toMatchObject({ kind: "video_note", duration_sec: 5 });
});

test("get hit, miss, and on-demand describe on a miss", async () => {
  const stored = entry("7");
  const base = {
    list: async (): Promise<VideoDescription[]> => [],
    get: async (id: string): Promise<VideoDescription | null> => (id === "7" ? stored : null),
  };
  const hit = JSON.parse(
    await runVideoDescriptionTool({ message_id: "7" }, { videoDescriptions: base }),
  );
  expect(hit.descriptions).toHaveLength(1);
  expect(await runVideoDescriptionTool({ message_id: "8" }, { videoDescriptions: base })).toBe(
    "Описание для этого сообщения не найдено.",
  );
  const described: string[] = [];
  const withDescribe = {
    ...base,
    describe: async (id: string): Promise<VideoDescription | null> => {
      described.push(id);
      return id === "8" ? entry("8", "Dog.") : null;
    },
  };
  const made = JSON.parse(
    await runVideoDescriptionTool({ message_id: "8" }, { videoDescriptions: withDescribe }),
  );
  expect(made.descriptions[0].description).toBe("Dog.");
  expect(
    await runVideoDescriptionTool({ message_id: "9" }, { videoDescriptions: withDescribe }),
  ).toContain("не найдено");
  expect(described).toStrictEqual(["8", "9"]);
});

test("descriptions are truncated, empty and invalid input are readable", async () => {
  const long = entry("1", "x".repeat(3000));
  const context = {
    videoDescriptions: {
      list: async () => [long],
      get: async (): Promise<VideoDescription | null> => null,
    },
  };
  const parsed = JSON.parse(await runVideoDescriptionTool({}, context));
  expect(parsed.descriptions[0].description).toHaveLength(1501);
  const empty = {
    videoDescriptions: {
      list: async (): Promise<VideoDescription[]> => [],
      get: async (): Promise<VideoDescription | null> => null,
    },
  };
  expect(await runVideoDescriptionTool({}, empty)).toBe("Описаний видео в этом чате нет.");
  expect(await runVideoDescriptionTool({ message_id: "x".repeat(33) }, empty)).toContain(
    "Некорректный",
  );
});

test("without the capability the tool answers readably", async () => {
  expect(await runVideoDescriptionTool({}, {})).toBe("Описания видео недоступны в этом чате.");
  const service = createToolService({ memory: {} as never } as never);
  const result = await service.runTool(
    { function: { name: "read_video_descriptions", arguments: {} } },
    {},
  );
  expect(result).toBe("Описания видео недоступны в этом чате.");
});
