/** @file Configure the resident Russian GigaAM backend and its shared lifecycle. */
import { resolvePath } from "../paths.ts";
import { projectDirectory } from "../project.ts";
import { createLocalSpeechServer } from "./local-server.ts";

/** Start GigaAM on a separate port so a healthy Whisper cannot silently be reused. */
export function createGigaamServer({
  python = "python3",
  modelDirectory = "models/gigaam",
  device = "auto",
  ...options
}: Omit<Parameters<typeof createLocalSpeechServer>[0], "command" | "origin" | "label"> & {
  python?: string;
  modelDirectory?: string;
  device?: "auto" | "cuda" | "cpu";
} = {}) {
  return createLocalSpeechServer({
    url: "http://127.0.0.1:8082/inference",
    startupTimeoutMs: 180000,
    ...options,
    origin: "http://127.0.0.1:8082",
    label: "gigaam",
    command: [
      python,
      "-u",
      resolvePath("scripts/gigaam-server.py", projectDirectory),
      "--models",
      resolvePath(modelDirectory, projectDirectory),
      "--device",
      device,
    ],
  });
}
