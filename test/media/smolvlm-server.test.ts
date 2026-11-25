/** @file Verify SmolVLM2 server command construction, lifecycle and configuration. */
import { expect, test } from "bun:test";
import { createSmolvlmServer } from "../../src/core/media/smolvlm-server.ts";
import { loadConfig } from "../../src/config.ts";
import { temporaryDirectory } from "../support/temp.ts";

test("configuration has defaults and validates SmolVLM and video-note settings", async () => {
  const directory = await temporaryDirectory("smolvlm-config-");
  await Bun.write(`${directory}/facts.json5`, "[]");
  await Bun.write(`${directory}/personality.json5`, "[]");
  const env = {
    BOT_ADAPTERS: "telegram",
    TELEGRAM_BOT_TOKEN: "fixture",
    LLAMA_MODEL: "fixture",
    OLLAMA_TIMEOUT: "30000",
    FACTS_FILE: `${directory}/facts.json5`,
    PERSONALITY_FILE: `${directory}/personality.json5`,
  };
  const config = await loadConfig(env);
  expect(config.smolvlm).toEqual({
    python: "python3",
    modelDirectory: "models/smolvlm2",
    device: "auto",
    url: "http://127.0.0.1:8083/describe",
    enabled: true,
    timeoutMs: 300000,
    maxFrames: 8,
    idleTimeoutMs: 300000,
  });
  expect(config.videoNoteDescription).toBe("reply");
  expect((await loadConfig({ ...env, SMOLVLM_AUTO_START: "false" })).smolvlm.enabled).toBe(false);
  expect(
    (await loadConfig({ ...env, VIDEO_NOTE_DESCRIPTION: "silent" })).videoNoteDescription,
  ).toBe("silent");
  for (const [name, value] of [
    ["SMOLVLM_DEVICE", "unknown"],
    ["VIDEO_NOTE_DESCRIPTION", "loud"],
    ["SMOLVLM_URL", "file:///tmp/x"],
    ["SMOLVLM_URL", "nonsense"],
    ["SMOLVLM_TIMEOUT_MS", "0"],
    ["SMOLVLM_IDLE_TIMEOUT_MS", "0"],
    ["SMOLVLM_MAX_FRAMES", "33"],
    ["SMOLVLM_MAX_FRAMES", "1.5"],
  ] as const)
    await expect(loadConfig({ ...env, [name]: value })).rejects.toThrow(name);
});

test("SmolVLM server builds its command and builds its command", async () => {
  const probes: string[] = [];
  let command: string[] = [];
  let code: number | null = null;
  let finish: (code: number) => void;
  const exited = new Promise<number>((resolve) => {
    finish = resolve;
  });
  const server = createSmolvlmServer({
    python: "/python/bin/python3",
    modelDirectory: "/models/smolvlm2",
    device: "cpu",
    maxFrames: 6,
    fetchImpl: async (url) => {
      probes.push(String(url));
      return Response.json({ status: probes.length > 1 ? "ok" : "loading" });
    },
    spawn: (args) => {
      command = args;
      return {
        get exitCode() {
          return code;
        },
        exited,
        kill() {
          code = 0;
          finish(0);
        },
      };
    },
  });
  await server.start();
  expect(probes[0]).toBe("http://127.0.0.1:8083/health");
  expect(command[0]).toBe("/python/bin/python3");
  expect(command[2]).toEndWith("/scripts/smolvlm-server.py");
  expect(command.slice(3)).toEqual([
    "--model",
    "/models/smolvlm2",
    "--device",
    "cpu",
    "--max-frames",
    "6",
  ]);
  await server.stop();
  expect(code).toBe(0);
});
