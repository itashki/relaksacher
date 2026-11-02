/** @file Configure the optional whisper.cpp backend using the shared process lifecycle. */
import { createLocalSpeechServer } from "./local-server.ts";

/** Start whisper.cpp on its standard loopback endpoint; reuse healthy external servers. */
export function createWhisperServer({
  model = "models/ggml-small.bin",
  ...options
}: Omit<Parameters<typeof createLocalSpeechServer>[0], "command" | "origin" | "label"> & {
  model?: string;
} = {}) {
  return createLocalSpeechServer({
    ...options,
    label: "whisper",
    command: [
      "whisper-server",
      "--host",
      "127.0.0.1",
      "--port",
      "8080",
      "-m",
      model,
      "--convert",
      "-t",
      "2",
    ],
  });
}
