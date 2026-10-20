/** @file Search routing and service-specific track filtering for indexed music providers. */
import { expect, test } from "bun:test";
import { searchMusic } from "../../src/adapters/discord/music/index.ts";
import { searchMusicIndex } from "../../src/adapters/music/index-search.ts";
import { fetchText } from "../../src/core/tools/web-fallback.ts";

test("Bandcamp, Audiomack and Yandex searches return only tracks from the requested service", async () => {
  const cases = [
    {
      prefix: "bc",
      scope: "site:bandcamp.com",
      track: "https://artist.bandcamp.com/track/song",
      album: "https://artist.bandcamp.com/album/song",
    },
    {
      prefix: "am",
      scope: "site:audiomack.com",
      track: "https://audiomack.com/artist/song/title",
      album: "https://audiomack.com/artist/album/title",
    },
    {
      prefix: "ym",
      scope: "site:music.yandex.ru",
      track: "https://music.yandex.ru/album/123/track/456",
      album: "https://music.yandex.ru/album/123",
    },
  ];
  for (const provider of cases) {
    const signal = new AbortController().signal;
    const result = await searchMusic(
      `  ${provider.prefix.toUpperCase()}: Artist & song`,
      signal,
      async () => {
        throw new Error("Must not invoke a nonexistent yt-dlp search extractor");
      },
      async (query, received) => {
        expect(received).toBe(signal);
        expect(query).toContain(provider.scope);
        expect(query).toContain("Artist & song");
        return [
          { title: "Wrong service", url: "https://soundcloud.com/artist/song" },
          { title: "Album", url: provider.album },
          { title: "Local", url: "https://localhost/song" },
          { title: "  Artist\n song  ", url: `${provider.track}?utm_source=search#player` },
          { title: "Duplicate", url: provider.track },
          { title: "Unsafe", url: provider.track.replace("https:", "http:") },
        ];
      },
    );
    expect(result).toEqual([{ title: "Artist song", url: provider.track }]);
  }
});

test("indexed searches bound result counts and titles and preserve regional or legacy track URLs", async () => {
  const signal = new AbortController().signal;
  const result = await searchMusic("bc: song", signal, undefined, async () =>
    Array.from({ length: 12 }, (_, i) => ({
      title: "x".repeat(300),
      url: `https://artist.bandcamp.com/track/song-${i}`,
    })),
  );
  expect(result).toHaveLength(5);
  expect(result[0].title).toHaveLength(150);
  for (const url of [
    "https://www.audiomack.com/song/artist/song",
    "https://music.yandex.kz/album/1/track/2",
    "https://music.yandex.com/album/1/track/2",
  ]) {
    const prefix = url.includes("audiomack") ? "am" : "ym";
    expect(
      await searchMusic(`${prefix}: song`, signal, undefined, async () => [{ title: "Song", url }]),
    ).toEqual([{ title: "Song", url }]);
  }
  await expect(searchMusic("ym:", signal)).rejects.toThrow("Введите название");
  await expect(searchMusic("am: song", signal, undefined, async () => [])).rejects.toThrow(
    "Ничего не найдено",
  );
  await expect(
    searchMusic("bc: song", signal, undefined, async () => {
      throw new Error("secret provider details");
    }),
  ).rejects.toThrow("Не удалось выполнить поиск");
});

test("music index and public-page transports honor cancellation before making requests", async () => {
  const controller = new AbortController();
  controller.abort();
  await expect(searchMusicIndex("site:bandcamp.com song", controller.signal)).rejects.toThrow();
  await expect(fetchText("https://example.com", controller.signal)).rejects.toThrow();
  await expect(
    searchMusic("am: song", controller.signal, undefined, async () => {
      throw new Error("must not search");
    }),
  ).rejects.toThrow();
});
