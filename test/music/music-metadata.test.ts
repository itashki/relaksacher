/** @file Track metadata parsing and safe linked panel presentation. */
import { expect, test } from "bun:test";
import { formatMusicTrack, loadMusicMetadata } from "../../src/adapters/music/metadata.ts";

const url = "https://soundcloud.com/artist/song";

test("track metadata uses bounded cancellable extraction without downloading audio", async () => {
  const signal = new AbortController().signal;
  const result = await loadMusicMetadata(url, signal, async (cmd, options) => {
    expect(options.signal).toBe(signal);
    expect(cmd[0]).toBe("yt-dlp");
    expect(cmd).toContain("--no-playlist");
    expect(cmd).toContain("--skip-download");
    expect(cmd.slice(-2)).toEqual(["--", url]);
    return JSON.stringify({ title: "  Artist\n— Song  ", duration: 245.9 });
  });
  expect(result).toEqual({ title: "Artist — Song", duration: 245, live: false });
  expect(formatMusicTrack(url, result)).toBe(`[Artist — Song](<${url}>) · 4:05`);
});

test("panel formats long tracks, livestreams and missing metadata", () => {
  expect(formatMusicTrack(url, { title: "Long track", duration: 3723, live: false })).toContain(
    "1:02:03",
  );
  expect(formatMusicTrack(url, { title: "Live", duration: 1, live: true })).toContain(
    "прямой эфир",
  );
  expect(formatMusicTrack(url, { title: "Short", duration: 0, live: false })).toContain("0:00");
  expect(formatMusicTrack(url, null, true)).toContain("Загрузка названия…");
  expect(formatMusicTrack(url, null)).toBe(`[Трек](<${url}>) · длительность неизвестна`);
  expect(formatMusicTrack(url, { title: "Unknown", duration: null, live: false })).toContain(
    "длительность неизвестна",
  );
});

test("metadata handles malformed responses and escapes provider titles and URL parentheses", async () => {
  const signal = new AbortController().signal;
  for (const response of ["invalid", "null", "{}", '{"title":"  "}']) {
    await expect(loadMusicMetadata(url, signal, async () => response)).rejects.toThrow();
  }
  for (const duration of [-1, "123", null]) {
    const metadata = await loadMusicMetadata(url, signal, async () =>
      JSON.stringify({ title: "x".repeat(300), duration }),
    );
    expect(metadata.duration).toBeNull();
    expect(metadata.title).toHaveLength(200);
  }
  const formatted = formatMusicTrack(`${url}(mix)`, {
    title: "[song](bad) **bold**",
    duration: 60,
    live: false,
  });
  expect(formatted).toContain("\\[song\\]");
  expect(formatted).toContain("\\*\\*bold\\*\\*");
  expect(formatted).toContain("song%28mix%29>");
  await expect(
    loadMusicMetadata(url, signal, async () => {
      throw new Error("Provider unavailable");
    }),
  ).rejects.toThrow("Provider unavailable");
});
