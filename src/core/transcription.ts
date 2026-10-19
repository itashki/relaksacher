/** @file Serialize voice downloads and whisper.cpp inference across all adapters. */
import PQueue from "p-queue";

/** Create a bounded single-worker transcription queue. Audio is loaded only when its job starts.
 * Rejects overload, transport failures, malformed responses and empty recognition results. */
export function createTranscriber({
  url = "http://127.0.0.1:8080/inference",
  timeoutMs = 300000,
  fetchImpl = fetch,
}: { url?: string; timeoutMs?: number; fetchImpl?: import("../types.ts").HttpFetch } = {}) {
  const queue = new PQueue({ concurrency: 1 });
  return async (load: () => Promise<Blob>): Promise<string> => {
    if (queue.size >= 20) throw new Error("Transcription queue is full");
    return queue.add(async () => {
      const audio = await load();
      if (!audio.size || audio.size > 20 * 1024 * 1024) throw new Error("Invalid audio size");
      const body = new FormData();
      body.set("file", audio, "voice.ogg");
      body.set("response_format", "json");
      body.set("language", "auto");
      body.set("translate", "false");
      const response = await fetchImpl(url, {
        method: "POST",
        body,
        signal: AbortSignal.timeout(timeoutMs),
        redirect: "error",
      });
      if (!response.ok) throw new Error("Whisper request failed");
      const result = (await response.json()) as { text?: unknown };
      if (typeof result.text !== "string" || !result.text.trim())
        throw new Error("Whisper returned no speech");
      return result.text.trim();
    });
  };
}
