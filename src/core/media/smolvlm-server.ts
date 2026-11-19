/** @file Configure the resident SmolVLM2 video-description backend and its shared lifecycle. */
import { resolvePath } from "../paths.ts";
import { projectDirectory } from "../project.ts";
import { createLocalSpeechServer } from "../speech/local-server.ts";

/** Loopback origin of the managed SmolVLM2 server; other origins are externally managed. */
export const smolvlmOrigin = "http://127.0.0.1:8083";

/** Start the SmolVLM2 Python server on its own port. Reuses a healthy server, never manages a
 * custom URL, allows up to five minutes for model loading, and `stop()` ends only our child. */
export function createSmolvlmServer({
  python = "python3",
  modelDirectory = "models/smolvlm2",
  device = "auto",
  maxFrames = 8,
  ...options
}: Omit<Parameters<typeof createLocalSpeechServer>[0], "command" | "origin" | "label"> & {
  python?: string;
  modelDirectory?: string;
  device?: "auto" | "cuda" | "cpu";
  maxFrames?: number;
} = {}) {
  return createLocalSpeechServer({
    url: "http://127.0.0.1:8083/describe",
    startupTimeoutMs: 300000,
    ...options,
    origin: smolvlmOrigin,
    label: "smolvlm",
    command: [
      python,
      "-u",
      resolvePath("scripts/smolvlm-server.py", projectDirectory),
      "--model",
      resolvePath(modelDirectory, projectDirectory),
      "--device",
      device,
      "--max-frames",
      String(maxFrames),
    ],
  });
}
