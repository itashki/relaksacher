/** @file Verify fresh transitive source loading and safe recovery after broken edits. */
import { expect, test, spyOn } from "bun:test";
import { Client, Events } from "discord.js";
import { loadApplication } from "../../src/runtime/loader.ts";
import { temporaryDirectory } from "../support/temp.ts";
import { createStatistics } from "../../src/core/statistics.ts";
import { projectDirectory } from "../../src/core/project.ts";

test("runtime rebuild reloads transitive edits and recovers after a syntax error", async () => {
  const directory = await temporaryDirectory("runtime-loader-");
  await Bun.write(
    `${directory}/src/runtime/application.ts`,
    `
    import { version } from "./version.ts";
    export async function loadConfig() { return { OLLAMA_MODEL: version }; }
  `,
  );
  await Bun.write(`${directory}/src/runtime/version.ts`, 'export const version = "first";');
  const first = await loadApplication(directory);
  expect(first.config.OLLAMA_MODEL).toBe("first");
  await Bun.write(`${directory}/src/runtime/version.ts`, 'export const version = "second";');
  const second = await loadApplication(directory);
  expect(second.config.OLLAMA_MODEL).toBe("second");
  expect((await first.module.loadConfig()).OLLAMA_MODEL).toBe("first");
  await Bun.write(`${directory}/src/runtime/version.ts`, "export const version = ;");
  await expect(loadApplication(directory)).rejects.toThrow();
  expect((await second.module.loadConfig()).OLLAMA_MODEL).toBe("second");
  await Bun.write(`${directory}/src/runtime/version.ts`, 'export const version = "fixed";');
  expect((await loadApplication(directory)).config.OLLAMA_MODEL).toBe("fixed");
  const artifacts = await Array.fromAsync(new Bun.Glob("**/*.mjs").scan(directory));
  expect(artifacts).toEqual([]);
});

test("real application bundle validates config and constructs offline without opening transports", async () => {
  const directory = await temporaryDirectory("runtime-config-");
  await Bun.write(`${directory}/facts.json5`, '["fixture fact"]');
  await Bun.write(`${directory}/personality.json5`, '["fixture personality"]');
  const prepared = await loadApplication(projectDirectory, {
    BOT_ADAPTERS: "telegram",
    TELEGRAM_BOT_TOKEN: "fixture",
    OLLAMA_URL: "http://127.0.0.1:11434",
    OLLAMA_MODEL: "fixture-model",
    OLLAMA_TIMEOUT: "30000",
    FACTS_FILE: `${directory}/facts.json5`,
    PERSONALITY_FILE: `${directory}/personality.json5`,
  });
  expect(prepared.config.facts).toEqual(["fixture fact"]);
  expect(prepared.config.personality).toBe("fixture personality");
  const application = prepared.module.createApplication(prepared.config, {}, () => {});
  expect(application.assistant.stopCurrentGeneration()).toBe(false);
  await application.dispose();
  const client = new Client({ intents: [] });
  const destroy = spyOn(client, "destroy");
  const managed = prepared.module.createApplication(prepared.config, { discord: client }, () => {});
  try {
    expect(client.listenerCount(Events.MessageCreate)).toBe(0);
    expect(client.listenerCount(Events.InteractionCreate)).toBe(0);
    await managed.dispose();
    expect(destroy).not.toHaveBeenCalled();
  } finally {
    destroy.mockRestore();
    await client.destroy();
  }
});

test("host statistics survive replacing application handlers", async () => {
  const directory = await temporaryDirectory("runtime-statistics-");
  await Bun.write(`${directory}/facts.json5`, "[]");
  await Bun.write(`${directory}/personality.json5`, "[]");
  const env = {
    BOT_ADAPTERS: "telegram",
    TELEGRAM_BOT_TOKEN: "fixture",
    OLLAMA_URL: "http://127.0.0.1:11434",
    OLLAMA_MODEL: "fixture-model",
    OLLAMA_TIMEOUT: "30000",
    FACTS_FILE: `${directory}/facts.json5`,
    PERSONALITY_FILE: `${directory}/personality.json5`,
  };
  const statistics = createStatistics(() => 90061000);
  for (let index = 0; index < 2; index++) {
    const prepared = await loadApplication(projectDirectory, env);
    const telegram = async (method: string) =>
      method === "getMe" ? { id: 99, username: "testbot" } : { message_id: 20 };
    const application = prepared.module.createApplication(
      prepared.config,
      { telegram: telegram as import("../../src/types.ts").TelegramApi },
      () => {},
      statistics.record,
    );
    try {
      await application.handle({
        kind: "telegram-update",
        update: {
          update_id: index,
          message: {
            message_id: index,
            date: 0,
            text: "!r d6",
            chat: { id: 1, type: "private", first_name: "User" },
            from: { id: 1, first_name: "User", is_bot: false },
          },
        },
      });
      expect(statistics.snapshot().total).toBe(index + 1);
      expect(statistics.snapshot().counts.roll).toBe(index + 1);
      expect(statistics.snapshot().uptimeMs).toBe(90061000);
    } finally {
      await application.dispose();
    }
  }
});
