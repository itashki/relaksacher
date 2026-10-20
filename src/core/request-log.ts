/** @file Serialized append-only request journal; never accepts assistant output or voice transcripts. */
// Bun has no append-to-path API; retain Node appendFile to preserve existing journal contents.
import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type { RequestFeature } from "./statistics.ts";

/** Incoming request metadata only; never include reply history, generated answers or transcripts. */
export type RequestContext = {
  platform: "discord" | "telegram";
  requestId: string;
  user: { id: string; name: string; username?: string };
  server: { id: string | null; name: string };
  channel: { id: string; name?: string; threadId?: string };
  text?: string;
};

/**
 * Append one JSON object per request in call order, retaining the journal across launches.
 * Write failures are reported without interrupting requests; later writes retry normally.
 * flush waits for queued writes; close rejects new records and drains the journal.
 */
export function createRequestLog(
  filename: string,
  {
    now = () => new Date(),
    report = (error: unknown) => console.error("Request log write failed:", error),
  } = {},
) {
  let pending = Promise.resolve();
  let closed = false;
  return {
    record(feature: RequestFeature, context?: RequestContext) {
      if (closed || !context) return;
      // Explicit fields prevent accidental runtime extras (responses, history) from leaking.
      const line =
        JSON.stringify({
          timestamp: now().toISOString(),
          feature,
          platform: context.platform,
          requestId: context.requestId,
          user: { id: context.user.id, name: context.user.name, username: context.user.username },
          server: { id: context.server.id, name: context.server.name },
          channel: {
            id: context.channel.id,
            name: context.channel.name,
            threadId: context.channel.threadId,
          },
          ...(feature === "transcribe" ? {} : { text: context.text }),
        }) + "\n";
      pending = pending
        .then(async () => {
          await mkdir(dirname(filename), { recursive: true });
          await appendFile(filename, line, { encoding: "utf8", mode: 0o600 });
        })
        .catch(report);
    },
    flush() {
      return pending;
    },
    close() {
      closed = true;
      return pending;
    },
  };
}
