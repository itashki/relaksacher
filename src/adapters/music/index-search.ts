/** @file Cancellable public-index search for supported services without yt-dlp search extractors. */
import { createWebFallback, fetchText } from "../../core/tools/web-fallback.ts";

/** Search transport returns candidate links; callers still validate the chosen music service and track path. */
export type MusicIndexSearch = (
  query: string,
  signal: AbortSignal,
) => Promise<{ title: string; url: string }[]>;

/** Search indexed public pages without API credentials; deadlines, cancellation and response caps apply. */
export const searchMusicIndex: MusicIndexSearch = async (query, signal) => {
  const cancellation = AbortSignal.any([signal, AbortSignal.timeout(15_000)]);
  cancellation.throwIfAborted();
  const client = createWebFallback({ getText: (url) => fetchText(url, cancellation) });
  const { results } = await client.webSearch({ query, max_results: 8 });
  cancellation.throwIfAborted();
  return results.map((item) => ({ title: item.title || item.url, url: item.url }));
};
