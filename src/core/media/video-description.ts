/** @file Serialize video loading and requests to the local SmolVLM2 description server. */
import PQueue from "p-queue";

/** Result of one successful video description. */
export type VideoDescriptionResult = {
  description: string;
  frames: number;
  duration: number;
  model: "SmolVLM2";
};

/** Queued client for the SmolVLM2 server; see `createVideoDescriber`. */
export type VideoDescriber = ReturnType<typeof createVideoDescriber>;

const maxVideoBytes = 20 * 1024 * 1024;
const maxWaiting = 10;

/** Create a single-worker video describer with at most 10 waiting jobs.
 * `describe(load, prompt?)` loads the video lazily when its job starts, requires 1 byte to
 * 20 MiB, posts multipart `file` (video.mp4) and optional `prompt`, and rejects on overload,
 * transport failure, timeout, non-OK status or a missing/empty `description`.
 * `available()` is false until `setAvailable(true)` is called after the server is ready;
 * callers skip work while it is false. */
export function createVideoDescriber({
  url = "http://127.0.0.1:8083/describe",
  timeoutMs = 300000,
  fetchImpl = fetch,
}: { url?: string; timeoutMs?: number; fetchImpl?: import("../../types.ts").HttpFetch } = {}) {
  const queue = new PQueue({ concurrency: 1 });
  let ready = false;
  return {
    /** True only after the server has been confirmed ready. */
    available: () => ready,
    /** Record readiness; set by application startup, never by callers of `describe`. */
    setAvailable(flag: boolean) {
      ready = flag;
    },
    /** Describe one video through the queue. */
    async describe(load: () => Promise<Blob>, prompt?: string): Promise<VideoDescriptionResult> {
      if (queue.size >= maxWaiting) throw new Error("Video description queue is full");
      return queue.add(async () => {
        const video = await load();
        if (!video.size || video.size > maxVideoBytes) throw new Error("Invalid video size");
        const body = new FormData();
        body.set("file", video, "video.mp4");
        if (prompt?.trim()) body.set("prompt", prompt.trim());
        const response = await fetchImpl(url, {
          method: "POST",
          body,
          signal: AbortSignal.timeout(timeoutMs),
          redirect: "error",
        });
        if (!response.ok) throw new Error("Video description request failed");
        const result = (await response.json().catch(() => ({}))) as {
          description?: unknown;
          frames?: unknown;
          duration?: unknown;
        };
        if (typeof result.description !== "string" || !result.description.trim())
          throw new Error("Video description returned no text");
        return {
          description: result.description.trim(),
          frames: typeof result.frames === "number" ? result.frames : 0,
          duration: typeof result.duration === "number" ? result.duration : 0,
          model: "SmolVLM2",
        };
      }) as Promise<VideoDescriptionResult>;
    },
  };
}
