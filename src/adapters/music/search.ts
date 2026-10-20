/** @file Search supported music providers and validate playable results. */
import { musicUrl } from "./url.ts";
import { runPlaylist, type PlaylistRunner } from "./youtube-playlist.ts";
import { searchMusicIndex, type MusicIndexSearch } from "./index-search.ts";
/** A display title and validated playable URL returned by a music search. */
export type MusicSearchResult = { title: string; url: string; duration?: number };

/** Search up to five tracks without downloading audio.
 * yt:/sc: use yt-dlp; bc:/am:/ym: search indexed public track pages. Default: YouTube. */
export async function searchMusic(
  query: string,
  signal: AbortSignal,
  run: PlaylistRunner = runPlaylist,
  indexed: MusicIndexSearch = searchMusicIndex,
): Promise<MusicSearchResult[]> {
  const prefix =
    query
      .trim()
      .match(/^(yt|sc|bc|am|ym):/i)?.[1]
      .toLowerCase() ?? "yt";
  const soundcloud = prefix === "sc";
  const text = query
    .trim()
    .replace(/^(sc|yt|bc|am|ym):/i, "")
    .trim();
  if (!text || text.length > 200) throw new Error("Введите название трека (до 200 символов).");
  signal.throwIfAborted();
  if (["bc", "am", "ym"].includes(prefix)) {
    const scopes: Record<string, string> = {
      bc: "site:bandcamp.com inurl:track",
      am: "site:audiomack.com inurl:song",
      ym: "(site:music.yandex.ru OR site:music.yandex.com OR site:music.yandex.kz OR site:music.yandex.by) inurl:album inurl:track",
    };
    let candidates: { title: string; url: string }[];
    try {
      candidates = await indexed(`${scopes[prefix]} ${text}`, signal);
    } catch {
      signal.throwIfAborted();
      throw new Error("Не удалось выполнить поиск. Попробуйте позже.");
    }
    signal.throwIfAborted();
    const results: MusicSearchResult[] = [];
    for (const candidate of candidates.slice(0, 8)) {
      try {
        const url = new URL(musicUrl(candidate.url));
        const matches =
          prefix === "bc"
            ? /^[a-z0-9-]+\.bandcamp\.com$/.test(url.hostname) &&
              /^\/track\/[^/]+\/?$/.test(url.pathname)
            : prefix === "am"
              ? ["audiomack.com", "www.audiomack.com"].includes(url.hostname) &&
                /^\/(?:song\/[^/]+\/[^/]+|[^/]+\/song\/[^/]+)\/?$/.test(url.pathname)
              : [
                  "music.yandex.ru",
                  "music.yandex.com",
                  "music.yandex.kz",
                  "music.yandex.by",
                ].includes(url.hostname) && /^\/album\/\d+\/track\/\d+\/?$/.test(url.pathname);
        if (!matches) continue;
        url.search = "";
        url.hash = "";
        if (results.some((item) => item.url === url.href)) continue;
        results.push({
          title: candidate.title.replace(/\s+/g, " ").trim().slice(0, 150) || url.href,
          url: url.href,
        });
        if (results.length === 5) break;
      } catch {
        /* Ignore non-track, foreign-service or malformed index results. */
      }
    }
    if (!results.length) throw new Error("Ничего не найдено. Уточните название трека.");
    return results;
  }
  let data: { entries?: unknown[] };
  try {
    data = JSON.parse(
      await run(
        [
          "--ignore-config",
          "--flat-playlist",
          "--dump-single-json",
          "--skip-download",
          "--socket-timeout",
          "15",
          "--retries",
          "1",
          "--",
          `${soundcloud ? "scsearch5" : "ytsearch5"}:${text}`,
        ],
        signal,
      ),
    );
  } catch {
    throw new Error(
      "Не удалось выполнить поиск. Проверьте доступность сервиса и установку yt-dlp.",
    );
  }
  const results: MusicSearchResult[] = [];
  for (const value of Array.isArray(data?.entries) ? data.entries.slice(0, 5) : []) {
    if (!value || typeof value !== "object") continue;
    const entry = value as {
      id?: unknown;
      title?: unknown;
      url?: unknown;
      webpage_url?: unknown;
      duration?: unknown;
    };
    try {
      const url = musicUrl(
        !soundcloud && typeof entry.id === "string" && /^[A-Za-z0-9_-]{11}$/.test(entry.id)
          ? `https://www.youtube.com/watch?v=${entry.id}`
          : String(entry.webpage_url ?? entry.url ?? ""),
      );
      results.push({
        ...(typeof entry.duration === "number" &&
        Number.isFinite(entry.duration) &&
        entry.duration >= 0
          ? { duration: Math.floor(entry.duration) }
          : {}),
        url,
        title:
          typeof entry.title === "string" ? entry.title.replace(/\s+/g, " ").slice(0, 150) : url,
      });
    } catch {
      /* Skip malformed or unsupported provider entries. */
    }
  }
  if (!results.length) throw new Error("Ничего не найдено. Уточните название трека.");
  return results;
}
