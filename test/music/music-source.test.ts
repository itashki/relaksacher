/** @file Music URL validation, provider search and YouTube extraction regression coverage. */
import { test, expect } from "bun:test";
import { musicUrl, searchMusic } from "../../src/adapters/discord/music/index.ts";

test("music accepts only supported HTTPS source URLs", () => {
  expect(musicUrl("<https://youtu.be/abc>")).toBe("https://youtu.be/abc");
  expect(musicUrl("https://soundcloud.com/artist/track")).toContain("soundcloud.com");
  for (const url of [
    "https://artist.bandcamp.com/track/song",
    "https://audiomack.com/artist/song/title",
    "https://music.yandex.ru/album/123/track/456",
  ])
    expect(musicUrl(url)).toBe(url);
  for (const url of [
    "file:///etc/passwd",
    "https://localhost/x",
    "https://youtube.com.evil.org/x",
    "http://youtube.com/x",
    "https://user:pass@youtube.com/x",
    "https://artist.bandcamp.com.evil.org/track/song",
    "https://music.yandex.ru.evil.org/track/1",
    "https://audiomack.com:444/song",
  ])
    expect(() => musicUrl(url)).toThrow();
});

test("YouTube playlist extraction canonicalizes watch links, bounds imports and filters entries", async () => {
  const { loadYouTubePlaylist, youtubePlaylistUrl } =
    await import("../../src/adapters/discord/music/index.ts");
  expect(youtubePlaylistUrl("https://youtu.be/abcdefghijk?list=PL_test&index=4")).toBe(
    "https://www.youtube.com/playlist?list=PL_test",
  );
  expect(youtubePlaylistUrl("https://soundcloud.com/a/b?list=PL_test")).toBeNull();
  expect(youtubePlaylistUrl("https://www.youtube.com/watch?v=abcdefghijk")).toBeNull();
  const result = await loadYouTubePlaylist(
    "https://youtube.com/playlist?list=PL_test",
    3,
    new AbortController().signal,
    async (args) => {
      expect(args).toContain("--flat-playlist");
      expect(args).toContain("--ignore-errors");
      expect(args[args.indexOf("--playlist-end") + 1]).toBe("4");
      expect(args.at(-1)).toBe("https://www.youtube.com/playlist?list=PL_test");
      return JSON.stringify({
        entries: [
          { id: "abcdefghijk" },
          { id: "12345678901", availability: "private" },
          { id: "zyxwvutsrqp" },
          { id: "extra123456" },
        ],
      });
    },
  );
  expect(result).toEqual({
    tracks: [
      "https://www.youtube.com/watch?v=abcdefghijk",
      "https://www.youtube.com/watch?v=zyxwvutsrqp",
    ],
    truncated: true,
    skipped: 1,
  });
  for (const output of [
    "invalid json",
    "null",
    "{}",
    '{"entries":[]}',
    '{"entries":[null,{"id":"invalid"}]}',
  ]) {
    await expect(
      loadYouTubePlaylist(
        "https://youtube.com/playlist?list=PL_test",
        3,
        new AbortController().signal,
        async () => output,
      ),
    ).rejects.toThrow();
  }
  await expect(
    loadYouTubePlaylist(
      "https://youtube.com/playlist?list=PL_test",
      3,
      new AbortController().signal,
      async () => {
        throw new Error("secret internal stderr");
      },
    ),
  ).rejects.toThrow("Не удалось загрузить");
});

test("YouTube imports skip deleted and private placeholders without availability metadata", async () => {
  const { loadYouTubePlaylist } = await import("../../src/adapters/discord/music/index.ts");
  const result = await loadYouTubePlaylist(
    "https://youtube.com/playlist?list=PL_test",
    10,
    new AbortController().signal,
    async () =>
      JSON.stringify({
        entries: [
          { id: "abcdefghijk", title: "[Deleted video]" },
          { id: "12345678901", title: "[Private video]" },
          null,
          { id: "abcdefghijk", availability: "needs_auth" },
          { id: "zyxwvutsrqp", title: "Available song", availability: "unlisted" },
        ],
      }),
  );
  expect(result).toEqual({
    tracks: ["https://www.youtube.com/watch?v=zyxwvutsrqp"],
    skipped: 4,
    truncated: false,
  });
  await expect(
    loadYouTubePlaylist(
      "https://youtube.com/playlist?list=PL_test",
      10,
      new AbortController().signal,
      async () => JSON.stringify({ entries: [{ id: "abcdefghijk", title: "[Deleted video]" }] }),
    ),
  ).rejects.toThrow("нет доступных треков");
});

test("music search bounds results, chooses provider and rejects invalid metadata", async () => {
  const signal = new AbortController().signal;
  const calls: string[][] = [];
  const run = async (args: string[], received: AbortSignal) => {
    expect(received).toBe(signal);
    calls.push(args);
    return JSON.stringify({
      entries: [
        { id: "abcdefghijk", title: "Song", url: "https://soundcloud.com/artist/song" },
        { id: "invalid", url: "http://localhost/private" },
        null,
      ],
    });
  };
  expect(await searchMusic("artist song", signal, run)).toEqual([
    { title: "Song", url: "https://www.youtube.com/watch?v=abcdefghijk" },
  ]);
  expect(calls[0].at(-1)).toBe("ytsearch5:artist song");
  expect(await searchMusic("sc: artist song", signal, run)).toEqual([
    { title: "Song", url: "https://soundcloud.com/artist/song" },
  ]);
  expect(calls[1].at(-1)).toBe("scsearch5:artist song");
  expect(calls[1]).toContain("--skip-download");
  for (const query of ["", "sc:  ", "x".repeat(201)])
    await expect(searchMusic(query, signal, run)).rejects.toThrow("Введите название");
  await expect(searchMusic("song", signal, async () => "bad json")).rejects.toThrow("Не удалось");
  await expect(
    searchMusic("song", signal, async () => JSON.stringify({ entries: [] })),
  ).rejects.toThrow("Ничего не найдено");
  const results = await searchMusic("song", signal, async () =>
    JSON.stringify({
      entries: Array.from({ length: 8 }, () => ({ id: "abcdefghijk", title: "x".repeat(500) })),
    }),
  );
  expect(results).toHaveLength(5);
  expect(results[0].title).toHaveLength(150);
});
