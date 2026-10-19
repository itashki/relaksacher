/** @file Persistence and migration coverage for named music playlists. */
import { expect, test } from "bun:test";
import { temporaryDirectory } from "./temp.ts";
import { musicUrl } from "../src/adapters/discord-music.ts";
import {
  createMusicLibrary,
  playlistName,
  readMusicLibrary,
  writeMusicLibrary,
} from "../src/adapters/music-library.ts";

test("legacy playlists migrate atomically and retain tracks, order and duplicates after restart", async () => {
  const file = `${await temporaryDirectory("music-library-")}/music_guild.json`;
  const tracks = ["https://youtu.be/one", "https://soundcloud.com/a/b", "https://youtu.be/one"];
  await Bun.write(file, JSON.stringify(tracks));
  const library = await readMusicLibrary(file, musicUrl);
  expect(library.version).toBe(2);
  expect(library.playlists).toEqual([{ id: library.activeId, name: "Основной", tracks }]);
  expect(await Bun.file(file).json()).toEqual(library);
  expect(await readMusicLibrary(file, musicUrl)).toEqual(library);
  expect(await Bun.file(`${file}.tmp`).exists()).toBe(false);
});

test("a missing library stays unwritten and named playlists retain their active selection", async () => {
  const file = `${await temporaryDirectory("music-library-")}/music_guild.json`;
  const library = await readMusicLibrary(file, musicUrl);
  expect(library.playlists[0].tracks).toEqual([]);
  expect(await Bun.file(file).exists()).toBe(false);
  library.playlists.push({ id: "second", name: "Для работы", tracks: ["https://youtu.be/two"] });
  library.activeId = "second";
  await writeMusicLibrary(file, library);
  expect(await readMusicLibrary(file, musicUrl)).toEqual(library);
});

test("invalid music libraries are rejected without changing the source file", async () => {
  const file = `${await temporaryDirectory("music-library-")}/music_guild.json`;
  const valid = createMusicLibrary();
  for (const data of [
    ["file:///etc/passwd"],
    Array(101).fill("https://youtu.be/one"),
    { ...valid, version: 3 },
    { ...valid, activeId: "missing" },
    { ...valid, playlists: [] },
    { ...valid, playlists: [valid.playlists[0], valid.playlists[0]] },
    {
      ...valid,
      playlists: [valid.playlists[0], { ...valid.playlists[0], id: "different", name: "основной" }],
    },
    { ...valid, playlists: [{ ...valid.playlists[0], tracks: [12] }] },
  ]) {
    const original = JSON.stringify(data);
    await Bun.write(file, original);
    await expect(readMusicLibrary(file, musicUrl)).rejects.toThrow();
    expect(await Bun.file(file).text()).toBe(original);
  }
  for (const name of ["", "  ", "x".repeat(61), "two\nlines", "hidden\u200b"])
    expect(() => playlistName(name)).toThrow();
  expect(playlistName("  Для работы  ")).toBe("Для работы");
});
