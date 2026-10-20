/** @file Extract bounded YouTube playlist metadata through yt-dlp. */
import { youtubePlaylistUrl } from "./music-url.ts";
import { runMusicCommand } from "./music-process.ts";
export type PlaylistResult = { tracks: string[]; truncated: boolean; skipped: number };
export type PlaylistRunner = (args: string[], signal: AbortSignal) => Promise<string>;
/** Run a yt-dlp metadata request with the shared output, timeout and cancellation limits. */
export const runPlaylist: PlaylistRunner = (args, signal) =>
  runMusicCommand(["yt-dlp", ...args], { signal });

/** Extract the first bounded playlist entries in source order without downloading audio.
 * @param limit Remaining capacity in the saved guild playlist, from 1 to 100.
 * @param signal Cancels metadata extraction during shutdown.
 * @returns Canonical video URLs and counts describing skipped or truncated entries.
 * @throws For inaccessible, malformed or empty playlists. */
export async function loadYouTubePlaylist(
  url: string,
  limit: number,
  signal: AbortSignal,
  run: PlaylistRunner = runPlaylist,
): Promise<PlaylistResult> {
  const canonical = youtubePlaylistUrl(url);
  if (!canonical || !Number.isInteger(limit) || limit < 1 || limit > 100)
    throw new Error("Некорректный запрос плейлиста.");
  let data: { entries?: unknown[] };
  try {
    data = JSON.parse(
      await run(
        [
          "--ignore-config",
          "--flat-playlist",
          "--yes-playlist",
          "--ignore-errors",
          "--dump-single-json",
          "--skip-download",
          "--socket-timeout",
          "15",
          "--retries",
          "1",
          "--playlist-end",
          String(limit + 1),
          "--",
          canonical,
        ],
        signal,
      ),
    );
  } catch {
    throw new Error(
      "Не удалось загрузить YouTube-плейлист. Проверьте ссылку, доступность плейлиста и установку yt-dlp.",
    );
  }
  if (!data || !Array.isArray(data.entries)) throw new Error("YouTube не вернул список треков.");
  const tracks: string[] = [];
  let skipped = 0;
  for (const value of data.entries.slice(0, limit)) {
    const entry = value as { id?: unknown; availability?: string; title?: unknown } | null;
    if (
      !entry ||
      typeof entry.id !== "string" ||
      !/^[A-Za-z0-9_-]{11}$/.test(entry.id) ||
      (typeof entry.title === "string" &&
        /^\[(?:deleted|private) video\]$/i.test(entry.title.trim())) ||
      ["private", "premium_only", "subscriber_only", "needs_auth"].includes(
        entry.availability ?? "",
      )
    ) {
      skipped++;
      continue;
    }
    tracks.push(`https://www.youtube.com/watch?v=${entry.id}`);
  }
  if (!tracks.length) throw new Error("В плейлисте нет доступных треков.");
  return { tracks, truncated: data.entries.length > limit, skipped };
}
