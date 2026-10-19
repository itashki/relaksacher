/** @file Replace voice history entries with attributed text and omit transcription delivery duplicates. */
import type { BackgroundMessage } from "../types.ts";

/** Keep a bounded runtime cache of successful transcripts and their delivery message identifiers.
 * normalize() preserves source order and substitutes an absent voice at its delivery position. */
export function createTranscriptHistory() {
  const records = new Map<string, { source: BackgroundMessage; replies: Set<string> }>();
  return {
    /** Record recognized text under the original speaker; text contains no presentation prefix. */
    remember(source: BackgroundMessage, replies: string[]) {
      records.delete(source.id);
      records.set(source.id, { source, replies: new Set(replies) });
      if (records.size > 1000) records.delete(records.keys().next().value);
    },
    /** Replace originals, collapse all delivery chunks, and retain ordinary nonempty messages. */
    normalize(messages: BackgroundMessage[]): BackgroundMessage[] {
      const byReply = new Map<string, BackgroundMessage>();
      for (const { source, replies } of records.values())
        for (const id of replies) byReply.set(id, source);
      const originals = new Set(
        messages.filter((message) => records.has(message.id)).map((message) => message.id),
      );
      const emitted = new Set<string>();
      const result: BackgroundMessage[] = [];
      for (const message of messages) {
        const source = records.get(message.id)?.source ?? byReply.get(message.id);
        if (source) {
          if (emitted.has(source.id) || (message.id !== source.id && originals.has(source.id)))
            continue;
          result.push({ ...message, ...source });
          emitted.add(source.id);
        } else if (message.content) result.push(message);
      }
      return result;
    },
  };
}
