/** @file Verify GigaAM selects a separate endpoint and a resident Python process. */
import { expect, test } from "bun:test";
import { createGigaamServer } from "../../src/core/speech/gigaam-server.ts";
import { loadConfig } from "../../src/config.ts";
import { temporaryDirectory } from "../support/temp.ts";

test("configuration selects GigaAM by default and validates backend and device", async () => {
  const directory = await temporaryDirectory("gigaam-config-");
  await Bun.write(`${directory}/facts.json5`, "[]");
  await Bun.write(`${directory}/personality.json5`, "[]");
  const env = {
    BOT_ADAPTERS: "telegram",
    TELEGRAM_BOT_TOKEN: "fixture",
    OLLAMA_URL: "http://127.0.0.1:11434",
    OLLAMA_MODEL: "fixture",
    OLLAMA_TIMEOUT: "30000",
    FACTS_FILE: `${directory}/facts.json5`,
    PERSONALITY_FILE: `${directory}/personality.json5`,
  };
  const config = await loadConfig(env);
  expect(config.transcriptionBackend).toBe("gigaam");
  expect(config.gigaam.url).toBe("http://127.0.0.1:8082/inference");
  expect(
    (await loadConfig({ ...env, TRANSCRIPTION_BACKEND: "whisper" })).transcriptionBackend,
  ).toBe("whisper");
  await expect(loadConfig({ ...env, TRANSCRIPTION_BACKEND: "unknown" })).rejects.toThrow(
    "TRANSCRIPTION_BACKEND",
  );
  await expect(loadConfig({ ...env, GIGAAM_DEVICE: "unknown" })).rejects.toThrow("GIGAAM_DEVICE");
  await expect(loadConfig({ ...env, GIGAAM_URL: "file:///tmp/model" })).rejects.toThrow(
    "GIGAAM_URL",
  );
});

test("GigaAM starts its own backend rather than reusing the Whisper endpoint", async () => {
  const probes: string[] = [];
  let command: string[] = [];
  let code: number | null = null;
  let finish: (code: number) => void;
  const exited = new Promise<number>((resolve) => {
    finish = resolve;
  });
  const server = createGigaamServer({
    python: "/python/bin/python3",
    modelDirectory: "/models/gigaam",
    device: "cuda",
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
  expect(probes).toEqual(["http://127.0.0.1:8082/health", "http://127.0.0.1:8082/health"]);
  expect(command[0]).toBe("/python/bin/python3");
  expect(command[2]).toEndWith("/scripts/gigaam-server.py");
  expect(command.slice(3)).toEqual(["--models", "/models/gigaam", "--device", "cuda"]);
  await server.stop();
  expect(code).toBe(0);
});

test("GigaAM does not manage a custom external endpoint", async () => {
  const server = createGigaamServer({
    url: "http://remote:8082/inference",
    fetchImpl: async () => {
      throw new Error("Must not probe");
    },
    spawn: () => {
      throw new Error("Must not spawn");
    },
  });
  await server.start();
  await server.stop();
});
