/** @file Application configuration and offline adapter construction preserve host-owned connections. */
import { expect, test, spyOn } from "bun:test";
import { Client, Events } from "discord.js";
import { loadConfig } from "../../src/config.ts";
import { createApplication } from "../../src/runtime/application.ts";
import { temporaryDirectory } from "../support/temp.ts";

test("real application bundle validates config and constructs offline without opening transports", async () => {
  const directory = await temporaryDirectory("runtime-config-");
  await Bun.write(`${directory}/facts.json5`, '["fixture fact"]');
  await Bun.write(`${directory}/personality.json5`, '["fixture personality"]');
  const config = await loadConfig({
    BOT_ADAPTERS: "telegram",
    TELEGRAM_BOT_TOKEN: "fixture",
    OLLAMA_URL: "http://127.0.0.1:11434",
    OLLAMA_MODEL: "fixture-model",
    OLLAMA_TIMEOUT: "30000",
    FACTS_FILE: `${directory}/facts.json5`,
    PERSONALITY_FILE: `${directory}/personality.json5`,
  });
  expect(config.facts).toEqual(["fixture fact"]);
  expect(config.personality).toBe("fixture personality");
  const application = createApplication(config, {}, () => {});
  expect(application.assistant.stopCurrentGeneration()).toBe(false);
  await application.dispose();
  const client = new Client({ intents: [] });
  const destroy = spyOn(client, "destroy");
  const managed = createApplication(config, { discord: client }, () => {});
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
