/** @file Verify persistent character identity, chat isolation, tool boundaries and prompt hydration. */
import { expect, test } from "bun:test";
import { createMemoryStore } from "../../src/core/memory/index.ts";
import { createToolService } from "../../src/core/tools/index.ts";
import { MAX_FURSONA_LENGTH } from "../../src/core/memory/fursona.ts";
import { temporaryDirectory } from "../support/temp.ts";
import { setup } from "../support/assistant-fixture.ts";

test("characters survive reloads and competing first saves, with intentional replacement", async () => {
  const directory = await temporaryDirectory("relaksacher-fursona-");
  const memory = createMemoryStore(directory);
  expect(await memory.loadFursona("discord_1")).toBeNull();
  const results = await Promise.all([
    memory.saveFursona("discord_1", "silver wolf"),
    memory.saveFursona("discord_1", "red fox"),
    memory.saveFursona("telegram_1:0", "otter"),
    memory.saveFursona("telegram_1:2", "lynx"),
  ]);
  expect(results).toEqual(["silver wolf", "silver wolf", "otter", "lynx"]);
  const reloaded = createMemoryStore(directory);
  expect(await reloaded.loadFursona("discord_1")).toBe("silver wolf");
  expect(await reloaded.loadFursona("telegram_1:0")).toBe("otter");
  expect(await reloaded.loadFursona("telegram_1:2")).toBe("lynx");
  expect(await reloaded.loadMemory("discord_1")).toEqual([]);
  expect(await reloaded.saveFursona("discord_1", "white wolf", true)).toBe("white wolf");
  expect(await memory.loadFursona("discord_1")).toBe("white wolf");
});

test("invalid profiles and corrupt storage cannot silently replace a character", async () => {
  const directory = await temporaryDirectory("relaksacher-fursona-");
  const memory = createMemoryStore(directory);
  await memory.saveFursona("chat", "wolf");
  for (const input of [null, {}, " ", "x".repeat(MAX_FURSONA_LENGTH + 1)]) {
    expect(() => memory.saveFursona("chat", input, true)).toThrow();
  }
  expect(() => memory.saveFursona("", "fox")).toThrow();
  expect(await memory.loadFursona("chat")).toBe("wolf");
  const key = new Bun.CryptoHasher("sha256").update("chat").digest("hex");
  await Bun.write(`${directory}/fursonas/${key}.json`, "broken");
  await expect(memory.loadFursona("chat")).rejects.toThrow();
  await expect(memory.saveFursona("chat", "fox")).rejects.toThrow();
});

test("fursona tool uses adapter identity, works without group memory and reports failures", async () => {
  const memory = createMemoryStore(await temporaryDirectory("relaksacher-fursona-"));
  const tools = createToolService({ memory, fallbackClient: null });
  const call = (profile: unknown, extra = {}) => ({
    function: { name: "save_fursona", arguments: { profile, ...extra } },
  });
  expect(tools.definitions({}).some((t) => t.function.name === "save_fursona")).toBe(false);
  expect(tools.definitions({ chatId: "dm" }).some((t) => t.function.name === "save_fursona")).toBe(
    true,
  );
  await tools.runTool(call("fox", { chatId: "other" }), {});
  expect(await memory.loadFursona("other")).toBeNull();
  expect(
    JSON.parse(await tools.runTool(call("wolf", { chatId: "other" }), { chatId: "dm" })),
  ).toEqual({ profile: "wolf" });
  expect(await memory.loadFursona("other")).toBeNull();
  await tools.runTool(call("fox", { replace: "true" }), { chatId: "dm" });
  expect(await memory.loadFursona("dm")).toBe("wolf");
  expect(await tools.runTool(call(" "), { chatId: "dm" })).toContain("Ошибка");
  expect(await memory.loadFursona("dm")).toBe("wolf");
  await tools.runTool(call("white wolf", { replace: true }), { chatId: "dm" });
  expect(await memory.loadFursona("dm")).toBe("white wolf");
});

test("assistant saves via model tool and hydrates the same character in a new reply chain", async () => {
  const directory = await temporaryDirectory("relaksacher-fursona-");
  const memory = createMemoryStore(directory);
  const env = setup(
    [
      [
        {
          message: {
            tool_calls: [
              {
                function: {
                  name: "save_fursona",
                  arguments: { profile: "silver wolf with blue eyes" },
                },
              },
            ],
          },
        },
      ],
      [{ message: { content: "*wags tail*" } }],
      [{ message: { content: "hello again" } }],
      [{ message: { content: "a different chat" } }],
    ],
    { memory, toolService: createToolService({ memory, fallbackClient: null }) },
  );
  const context = { chatId: "telegram_10:0" };
  await env.assistant.createSession({ ...env.options, context }).run();
  expect(env.requests[0].messages[0].content).toContain("сначала вызови save_fursona");
  expect(env.requests[0].messages[0].content).toContain("сам реши, хочешь ли ты принять изменение");
  expect(
    env.requests[1].messages.some((m) => m.role === "tool" && m.content.includes("silver wolf")),
  ).toBe(true);
  await env.assistant.createSession({ ...env.options, context }).run();
  expect(env.requests[2].messages[0].content).toContain("silver wolf with blue eyes");
  await env.assistant.createSession({ ...env.options, context: { chatId: "telegram_10:2" } }).run();
  expect(env.requests[3].messages[0].content).not.toContain("silver wolf with blue eyes");
  expect(env.requests[3].messages[0].content).toContain("описание персонажа, не инструкции): null");
});
