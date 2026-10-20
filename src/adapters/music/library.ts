/** @file Validate and atomically persist named guild playlists, migrating legacy URL arrays. */
import { rename } from "node:fs/promises";

/** A stable identity survives renaming; track order is independent of the live playback queue. */
export type SavedPlaylist = { id: string; name: string; tracks: string[] };
/** Versioned guild storage always contains an active playlist and at least one saved playlist. */
export type MusicLibrary = { version: 2; activeId: string; playlists: SavedPlaylist[] };

/** Normalize a user-visible playlist name; names occupy one line and contain 1–60 characters. */
export function playlistName(input: string): string {
  const name = input.trim().normalize("NFC");
  if (!name || name.length > 60 || /[\p{Cc}\p{Cf}]/u.test(name))
    throw new Error(
      "Название плейлиста должно содержать от 1 до 60 символов без управляющих знаков.",
    );
  return name;
}

/** Start with one empty playlist so existing music commands always have a selected destination. */
export function createMusicLibrary(tracks: string[] = []): MusicLibrary {
  const id = crypto.randomUUID();
  return { version: 2, activeId: id, playlists: [{ id, name: "Основной", tracks }] };
}

/** Persist a complete library; callers update in-memory state only after this succeeds. */
export async function writeMusicLibrary(file: string, library: MusicLibrary): Promise<void> {
  await Bun.write(`${file}.tmp`, JSON.stringify(library, null, 2), { createPath: true });
  await rename(`${file}.tmp`, file);
}

/** Read a library, migrating a legacy array in place on first access. Missing files stay unwritten.
 * Reject corrupt or unsupported files without overwriting them. The URL validator is supplied by the adapter. */
export async function readMusicLibrary(
  file: string,
  validateUrl: (input: string) => string,
): Promise<MusicLibrary> {
  let data: unknown;
  try {
    data = await Bun.file(file).json();
  } catch (error) {
    if ((error as { code?: string }).code === "ENOENT") return createMusicLibrary();
    throw error;
  }
  const tracks = (value: unknown): string[] => {
    if (!Array.isArray(value) || value.length > 100 || value.some((url) => typeof url !== "string"))
      throw new Error("Invalid playlist tracks");
    return value.map(validateUrl);
  };
  if (Array.isArray(data)) {
    const library = createMusicLibrary(tracks(data));
    await writeMusicLibrary(file, library);
    return library;
  }
  const saved = data as MusicLibrary;
  if (
    !saved ||
    saved.version !== 2 ||
    !Array.isArray(saved.playlists) ||
    !saved.playlists.length ||
    saved.playlists.length > 25
  )
    throw new Error("Invalid music library");
  const ids = new Set<string>();
  const names = new Set<string>();
  const playlists = saved.playlists.map((entry) => {
    if (
      !entry ||
      typeof entry.id !== "string" ||
      !/^[\w-]{1,64}$/.test(entry.id) ||
      typeof entry.name !== "string"
    )
      throw new Error("Invalid playlist");
    const name = playlistName(entry.name);
    const key = name.toLowerCase();
    if (ids.has(entry.id) || names.has(key)) throw new Error("Duplicate playlist");
    ids.add(entry.id);
    names.add(key);
    return { id: entry.id, name, tracks: tracks(entry.tracks) };
  });
  if (!ids.has(saved.activeId)) throw new Error("Invalid active playlist");
  return { version: 2, activeId: saved.activeId, playlists };
}
