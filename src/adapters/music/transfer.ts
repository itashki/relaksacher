/** @file Portable playlist JSON and bounded downloads of Discord message attachments. */
import { playlistName, type SavedPlaylist } from "./library.ts";

const maxBytes = 128 * 1024;
type PortablePlaylist = {
  format: "relaksacher-playlist";
  version: 1;
  name: string;
  tracks: string[];
};

/** Export only the name and ordered URLs, excluding guild state and internal playlist IDs. */
export function exportPlaylist(playlist: SavedPlaylist): string {
  return JSON.stringify(
    {
      format: "relaksacher-playlist",
      version: 1,
      name: playlist.name,
      tracks: playlist.tracks,
    } satisfies PortablePlaylist,
    null,
    2,
  );
}

/** Validate a portable file in full before importing; never truncate or partially accept invalid tracks. */
export function parsePlaylist(
  text: string,
  validateUrl: (url: string) => string,
): Pick<SavedPlaylist, "name" | "tracks"> {
  if (new TextEncoder().encode(text).byteLength > maxBytes)
    throw new Error("Файл плейлиста превышает 128 КиБ.");
  let value: PortablePlaylist;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error("Файл плейлиста должен содержать корректный JSON.");
  }
  if (
    !value ||
    value.format !== "relaksacher-playlist" ||
    value.version !== 1 ||
    typeof value.name !== "string" ||
    !Array.isArray(value.tracks) ||
    value.tracks.length > 100 ||
    value.tracks.some((url) => typeof url !== "string")
  )
    throw new Error(
      "Неверный формат плейлиста. Используйте файл из !music playlist export (до 100 треков).",
    );
  return { name: playlistName(value.name), tracks: value.tracks.map(validateUrl) };
}

/** Download one Discord attachment with a size cap, a 15-second deadline and shutdown cancellation.
 * Reject arbitrary hosts and redirects; signed CDN query parameters are retained. */
export async function downloadPlaylist(
  attachment: { url: string; size: number },
  signal: AbortSignal,
  fetchFile: (url: string, options: RequestInit) => Promise<Response> = fetch,
): Promise<string> {
  const url = new URL(attachment.url);
  if (
    url.protocol !== "https:" ||
    !["cdn.discordapp.com", "media.discordapp.net"].includes(url.hostname) ||
    url.port ||
    url.username ||
    url.password ||
    !url.pathname.startsWith("/attachments/")
  )
    throw new Error("Прикрепите JSON-файл плейлиста к сообщению с командой импорта.");
  if (!Number.isFinite(attachment.size) || attachment.size < 0 || attachment.size > maxBytes)
    throw new Error("Файл плейлиста превышает 128 КиБ.");
  const cancellation = AbortSignal.any([signal, AbortSignal.timeout(15_000)]);
  cancellation.throwIfAborted();
  const response = await fetchFile(url.href, { signal: cancellation, redirect: "error" });
  if (!response.ok || !response.body) {
    await response.body?.cancel();
    throw new Error("Не удалось скачать файл плейлиста. Прикрепите его заново.");
  }
  const reader = response.body.getReader();
  let size = 0;
  let text = "";
  const decoder = new TextDecoder("utf-8", { fatal: true });
  try {
    while (true) {
      cancellation.throwIfAborted();
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) throw new Error("Файл плейлиста превышает 128 КиБ.");
      text += decoder.decode(value, { stream: true });
    }
    cancellation.throwIfAborted();
    return text + decoder.decode();
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
