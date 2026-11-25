/** @file Serialize voice downloads and compatible speech-server requests across all adapters. */
import PQueue from "p-queue";
import { gigaamKey } from "../llama/servers.ts";

/** Create a bounded single-worker transcription queue. Audio is loaded only when its job starts.
 * Rejects overload, transport failures, malformed responses and empty recognition results.
 * With `servers` (the model manager) each request runs as `servers.use(gigaamKey, …)`: GigaAM
 * starts on demand and the timeout starts inside the job, so lock wait and cold start are not
 * counted. Without it the request is sent directly. */
export function createTranscriber({
  url = "http://127.0.0.1:8080/inference",
  timeoutMs = 300000,
  fetchImpl = fetch,
  servers,
}: {
  url?: string;
  timeoutMs?: number;
  fetchImpl?: import("../../types.ts").HttpFetch;
  servers?: { use<T>(key: string, job: () => Promise<T>): Promise<T> };
} = {}) {
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
      // The body is read inside the job: the server is stopped as soon as the job returns.
      const post = async () => {
        const response = await fetchImpl(url, {
          method: "POST",
          body,
          signal: AbortSignal.timeout(timeoutMs),
          redirect: "error",
        });
        if (!response.ok) throw new Error("Transcription request failed");
        return (await response.json()) as { text?: unknown };
      };
      const result = await (servers ? servers.use(gigaamKey, post) : post());
      if (typeof result.text !== "string" || !result.text.trim())
        throw new Error("Transcription returned no speech");
      return result.text.trim();
    });
  };
}
