/** @file Portable playlist validation and bounded Discord CDN download coverage. */
import { expect, test } from "bun:test";
import { downloadPlaylist, exportPlaylist, parsePlaylist } from "../src/adapters/music-transfer.ts";
import { musicUrl } from "../src/adapters/discord-music.ts";

test("portable playlists preserve empty lists, order, duplicates and Unicode names", () => {
  for (const tracks of [
    [],
    ["https://youtu.be/one", "https://soundcloud.com/a/b", "https://youtu.be/one"],
  ]) {
    const saved = { id: "internal", name: "Музыка 🎵", tracks };
    expect(parsePlaylist(exportPlaylist(saved), musicUrl)).toEqual({ name: saved.name, tracks });
    expect(exportPlaylist(saved)).not.toContain("internal");
  }
});

test("portable playlists reject corrupt JSON, unknown versions, invalid names, tracks and excessive sizes", () => {
  const valid = {
    format: "relaksacher-playlist",
    version: 1,
    name: "Music",
    tracks: ["https://youtu.be/one"],
  };
  for (const value of [
    null,
    [],
    {},
    { ...valid, format: "other" },
    { ...valid, version: 2 },
    { ...valid, name: "" },
    { ...valid, name: "two\nlines" },
    { ...valid, tracks: [12] },
    { ...valid, tracks: ["https://localhost/audio"] },
    { ...valid, tracks: Array(101).fill("https://youtu.be/one") },
  ])
    expect(() => parsePlaylist(JSON.stringify(value), musicUrl)).toThrow();
  expect(() => parsePlaylist("not json", musicUrl)).toThrow("корректный JSON");
  expect(() => parsePlaylist("я".repeat(70_000), musicUrl)).toThrow("128 КиБ");
});

test("playlist downloads accept signed Discord attachments and reject arbitrary hosts and large bodies", async () => {
  const signal = new AbortController().signal;
  const url = "https://cdn.discordapp.com/attachments/channel/file/playlist.json?ex=signed";
  expect(
    await downloadPlaylist({ url, size: 10 }, signal, async (input, options) => {
      expect(input).toBe(url);
      expect(options.redirect).toBe("error");
      expect(options.signal).toBeInstanceOf(AbortSignal);
      return new Response("Музыка 🎵");
    }),
  ).toBe("Музыка 🎵");
  for (const invalid of [
    "http://cdn.discordapp.com/attachments/a",
    "https://localhost/file",
    "https://cdn.discordapp.com.evil.org/attachments/a",
    "https://cdn.discordapp.com/other/file",
    "https://user@cdn.discordapp.com/attachments/a",
  ]) {
    await expect(
      downloadPlaylist({ url: invalid, size: 0 }, signal, async () => {
        throw new Error("must not fetch");
      }),
    ).rejects.toThrow("Прикрепите JSON-файл");
  }
  await expect(downloadPlaylist({ url, size: 200_000 }, signal)).rejects.toThrow("128 КиБ");
  await expect(
    downloadPlaylist({ url, size: 1 }, signal, async () => new Response("x".repeat(140_000))),
  ).rejects.toThrow("128 КиБ");
  await expect(
    downloadPlaylist(
      { url, size: 1 },
      signal,
      async () => new Response("missing", { status: 404 }),
    ),
  ).rejects.toThrow("Не удалось скачать");
  const cancelled = new AbortController();
  cancelled.abort();
  await expect(
    downloadPlaylist({ url, size: 1 }, cancelled.signal, async () => {
      throw new Error("must not fetch");
    }),
  ).rejects.toThrow();
});
