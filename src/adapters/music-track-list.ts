/** @file Cache track metadata and render bounded Discord playlist pages and selectors. */
import { ActionRowBuilder, StringSelectMenuBuilder } from "discord.js";
import { loadMusicMetadata, formatMusicTrack, type MusicMetadata } from "./music-metadata.ts";

/** Create a controller-local metadata cache and list renderer.
 * Playback uses its own cancellation signal; list lookups share the shutdown signal.
 * isClosed prevents delivery after the owning music controller stops. */
export function createMusicTrackList(
  loadMetadata: typeof loadMusicMetadata,
  signal: AbortSignal,
  isClosed: () => boolean,
) {
  const metadataCache = new Map<string, { value: MusicMetadata | null; expires: number }>();
  const listingLookups = new Map<string, Promise<MusicMetadata | null>>();
  /** Cache successful lookups for an hour and provider failures for a minute, bounded to 500 URLs. */
  async function trackMetadata(url: string, signal: AbortSignal): Promise<MusicMetadata | null> {
    signal.throwIfAborted();
    const cached = metadataCache.get(url);
    if (cached && cached.expires > Date.now()) return cached.value;
    let value: MusicMetadata | null = null;
    try {
      value = await loadMetadata(url, signal);
    } catch {
      signal.throwIfAborted();
    }
    signal.throwIfAborted();
    while (metadataCache.size >= 500) metadataCache.delete(metadataCache.keys().next().value!);
    metadataCache.set(url, { value, expires: Date.now() + (value ? 3_600_000 : 60_000) });
    return value;
  }
  /** Coalesce list lookups while keeping playback cancellation independent. */
  function listingMetadata(url: string): Promise<MusicMetadata | null> {
    const existing = listingLookups.get(url);
    if (existing) return existing;
    const task = trackMetadata(url, signal).finally(() => listingLookups.delete(url));
    listingLookups.set(url, task);
    return task;
  }
  /** Render a stable queue snapshot with at most three concurrent lookups and bounded Discord pages. */
  async function sendTrackList(
    tracks: string[],
    current: string,
    empty: string,
    reply: (
      text: string,
      components?: ActionRowBuilder<StringSelectMenuBuilder>[],
    ) => Promise<void>,
    selectionToken?: string,
    heading?: string,
  ) {
    const urls = [...new Set([...(current ? [current] : []), ...tracks])];
    const metadata = new Map<string, MusicMetadata | null>();
    let cursor = 0;
    await Promise.all(
      Array.from({ length: Math.min(3, urls.length) }, async () => {
        while (cursor < urls.length) {
          signal.throwIfAborted();
          const url = urls[cursor++];
          metadata.set(url, await listingMetadata(url));
        }
      }),
    );
    if (isClosed()) return;
    const lines = [
      ...(heading ? [heading] : []),
      ...(current ? [`Сейчас: ${formatMusicTrack(current, metadata.get(current) ?? null)}`] : []),
      ...(tracks.length
        ? tracks.map((url, i) => `${i + 1}. ${formatMusicTrack(url, metadata.get(url) ?? null)}`)
        : [empty]),
    ];
    let page = "";
    for (const line of lines) {
      if (page && page.length + line.length + 1 > 1900) {
        await reply(page);
        page = "";
      }
      page += `${page ? "\n" : ""}${line}`;
    }
    if (page && !isClosed()) {
      const components: ActionRowBuilder<StringSelectMenuBuilder>[] = [];
      if (selectionToken)
        for (let offset = 0; offset < tracks.length; offset += 25) {
          const select = new StringSelectMenuBuilder()
            .setCustomId(`music:jump:${selectionToken}:${offset}`)
            .setPlaceholder(`Включить трек ${offset + 1}–${Math.min(offset + 25, tracks.length)}`)
            .addOptions(
              tracks.slice(offset, offset + 25).map((url, i) => ({
                label: `${offset + i + 1}. ${metadata.get(url)?.title ?? url}`.slice(0, 100),
                value: String(offset + i),
                description: formatMusicTrack(url, metadata.get(url) ?? null)
                  .split(" · ")
                  .at(-1)!
                  .slice(0, 100),
              })),
            );
          components.push(new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select));
        }
      await reply(page, components.length ? components : undefined);
    }
  }
  return { trackMetadata, listingMetadata, sendTrackList };
}
