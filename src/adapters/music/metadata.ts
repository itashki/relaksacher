/** @file Load bounded track metadata and render safe Discord links with total duration. */
import { escapeMarkdown } from "discord.js";
import { runMusicCommand } from "./process.ts";

/** Display metadata; null duration means the provider did not report a finite length. */
export type MusicMetadata = { title: string; duration: number | null; live: boolean };
type MetadataRunner = (cmd: string[], options: { signal: AbortSignal }) => Promise<string>;

/** Read one track's metadata without downloading audio; cancellation terminates yt-dlp.
 * The caller validates the source URL and handles provider errors independently of playback. */
export async function loadMusicMetadata(
  url: string,
  signal: AbortSignal,
  run: MetadataRunner = runMusicCommand,
): Promise<MusicMetadata> {
  const data: unknown = JSON.parse(
    await run(
      [
        "yt-dlp",
        "--ignore-config",
        "--no-playlist",
        "--skip-download",
        "--dump-single-json",
        "--socket-timeout",
        "15",
        "--retries",
        "1",
        "--",
        url,
      ],
      { signal },
    ),
  );
  if (!data || typeof data !== "object") throw new Error("Invalid track metadata");
  const entry = data as { title?: unknown; duration?: unknown; is_live?: unknown };
  if (typeof entry.title !== "string" || !entry.title.trim())
    throw new Error("Missing track title");
  return {
    title: entry.title.replace(/\s+/g, " ").trim().slice(0, 200),
    duration:
      typeof entry.duration === "number" && Number.isFinite(entry.duration) && entry.duration >= 0
        ? Math.floor(entry.duration)
        : null,
    live: entry.is_live === true,
  };
}

/** Render a linked title and total length (m:ss or h:mm:ss), with explicit loading/error fallbacks.
 * URL must be validated by musicUrl before calling this formatter. */
export function formatMusicTrack(
  url: string,
  metadata: MusicMetadata | null,
  loading = false,
): string {
  let duration = loading ? "загрузка…" : "длительность неизвестна";
  if (metadata?.live) duration = "прямой эфир";
  else if (metadata?.duration != null) {
    const seconds = metadata.duration;
    const minutes = Math.floor(seconds / 60);
    duration =
      minutes >= 60
        ? `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`
        : `${minutes}:${String(seconds % 60).padStart(2, "0")}`;
  }
  const title = escapeMarkdown(
    metadata?.title ?? (loading ? "Загрузка названия…" : "Трек"),
  ).replace(/[[\]]/g, "\\$&");
  const target = url.replace(/\(/g, "%28").replace(/\)/g, "%29");
  return `[${title}](<${target}>) · ${duration}`;
}
