/** @file Regression coverage for music behavior and its external boundaries. */
import { test, expect } from "bun:test";
import { temporaryDirectory } from "../support/temp.ts";
import { resolvePath } from "../../src/core/paths.ts";
import { createDiscordMusic } from "../../src/adapters/discord/music/index.ts";
import type { Message } from "discord.js";
import { ChannelType } from "discord.js";

test("music serializes playlist edits and restores them after restart", async () => {
  const directory = resolvePath("new/nested #memory%", await temporaryDirectory("music-test-"));
  let music = createDiscordMusic(directory, {
    loadMetadata: async () => ({ title: "Saved song", duration: 125, live: false }),
  });
  const replies: string[] = [];
  const message = (content: string, voice = true) =>
    ({
      content,
      author: { id: "user" },
      guild: {
        id: "123",
        members: {
          fetch: async () => ({
            voice: { channel: voice ? { id: "voice", type: ChannelType.GuildVoice } : null },
          }),
        },
      },
      reply: async (payload: { content: string }) => {
        replies.push(payload.content);
      },
    }) as unknown as Message;
  try {
    await Promise.all([
      music.handle(message("!music https://youtu.be/one")),
      music.handle(message("!music add https://soundcloud.com/a/b")),
    ]);
    music.stop();
    music = createDiscordMusic(directory, {
      loadMetadata: async () => ({ title: "Saved song", duration: 125, live: false }),
    });
    await music.handle(message("!music list", false));
    expect(replies.at(-1)).toContain("1. [Saved song](<https://youtu.be/one>) · 2:05");
    expect(replies.at(-1)).toContain("2. [Saved song](<https://soundcloud.com/a/b>) · 2:05");
    await music.handle(message("!music remove 1", false));
    expect(replies.at(-1)).toContain("войдите");
    await music.handle(message("!music remove 1"));
    await music.handle(message("!music list"));
    expect(replies.at(-1)).not.toContain("youtu.be/one");
    expect(replies.at(-1)).toContain("soundcloud.com/a/b");
    expect(await music.handle(message("ordinary message"))).toBe(false);
  } finally {
    music.stop();
  }
});

test("playlist imports persist ordered tracks, respect remaining capacity and preserve state on failure", async () => {
  const directory = await temporaryDirectory("music-import-test-");
  const replies: string[] = [];
  let fail = false;
  const music = createDiscordMusic(directory, {
    loadPlaylist: async (url, limit) => {
      expect(url).toBe("https://www.youtube.com/playlist?list=PL_test");
      expect(limit).toBe(fail ? 97 : 99);
      if (fail) throw new Error("Playlist unavailable");
      return {
        tracks: [
          "https://www.youtube.com/watch?v=abcdefghijk",
          "https://www.youtube.com/watch?v=zyxwvutsrqp",
        ],
        truncated: true,
        skipped: 1,
      };
    },
  });
  const message = (content: string) =>
    ({
      content,
      author: { id: "user" },
      guild: {
        id: "456",
        members: {
          fetch: async () => ({
            voice: { channel: { id: "voice", type: ChannelType.GuildVoice } },
          }),
        },
      },
      reply: async (payload: { content: string }) => {
        replies.push(payload.content);
      },
    }) as unknown as Message;
  try {
    await music.handle(message("!music add https://youtu.be/one"));
    await music.handle(message("!music https://youtube.com/watch?v=abcdefghijk&list=PL_test"));
    expect(replies.at(-1)).toContain("Добавлено треков: 2");
    expect(replies.at(-1)).toContain("начальная часть");
    expect(replies.at(-1)).toContain("пропущено: 1");
    fail = true;
    await music.handle(message("!music add https://youtube.com/playlist?list=PL_test"));
    expect(replies.at(-1)).toBe("Playlist unavailable");
    expect(
      (await Bun.file(resolvePath("music_456.json", directory)).json()).playlists[0].tracks,
    ).toEqual([
      "https://youtu.be/one",
      "https://www.youtube.com/watch?v=abcdefghijk",
      "https://www.youtube.com/watch?v=zyxwvutsrqp",
    ]);
  } finally {
    music.stop();
  }
});

test("music telemetry publishes playlist, import, error and shutdown changes without a Discord panel", async () => {
  const { createMusicMonitor } = await import("../../src/core/music/status.ts");
  const directory = await temporaryDirectory("music-monitor-test-");
  const monitor = createMusicMonitor();
  const snapshots: import("../../src/core/music/status.ts").MusicStatus[][] = [];
  const unsubscribe = monitor.subscribe((statuses) => snapshots.push(statuses));
  const music = createDiscordMusic(directory, {
    onStatus: monitor.publish,
    loadPlaylist: async () => ({
      tracks: ["https://www.youtube.com/watch?v=abcdefghijk"],
      truncated: false,
      skipped: 0,
    }),
  });
  const request = (content: string) =>
    ({
      content,
      author: { id: "user" },
      guild: {
        id: "123",
        name: "MusicServer",
        members: {
          fetch: async () => ({
            voice: { channel: { id: "voice", type: ChannelType.GuildVoice } },
          }),
        },
      },
      reply: async () => {},
    }) as unknown as Message;
  try {
    expect(snapshots).toEqual([[]]);
    await music.handle(request("!music add https://youtube.com/playlist?list=PL_test"));
    expect(snapshots.some((snapshot) => snapshot[0]?.status === "importing")).toBe(true);
    expect(snapshots.at(-1)[0]).toMatchObject({
      guildId: "123",
      guildName: "MusicServer",
      status: "stopped",
      current: "",
      channelId: null,
      saved: 1,
      queued: 0,
    });
    await music.handle(request("!music remove 99"));
    expect(snapshots.at(-1)[0].error).toContain("Укажите номер трека");
    await music.handle(request("!music repeat all"));
    await music.handle(request("!music shuffle on"));
    expect(snapshots.at(-1)[0]).toMatchObject({ repeat: "all", shuffle: true });
    music.stop();
    expect(snapshots.at(-1)[0]).toMatchObject({ status: "stopped", channelId: null, queued: 0 });
    let replay: import("../../src/core/music/status.ts").MusicStatus[];
    const off = monitor.subscribe((statuses) => {
      replay = statuses;
    });
    expect(replay[0].saved).toBe(1);
    replay[0].saved = 99;
    off();
    const other = monitor.subscribe((statuses) => expect(statuses[0].saved).toBe(1));
    other();
    unsubscribe();
    const count = snapshots.length;
    monitor.publish([]);
    expect(snapshots.length).toBe(count);
  } finally {
    unsubscribe();
    music.stop();
  }
});

test("music shutdown cancels a running import and waits for the command to settle", async () => {
  const directory = await temporaryDirectory("music-shutdown-test-");
  let began: () => void;
  let signal: AbortSignal;
  const started = new Promise<void>((resolve) => {
    began = resolve;
  });
  const music = createDiscordMusic(directory, {
    loadPlaylist: async (_url, _limit, cancellation) => {
      signal = cancellation;
      began();
      return new Promise((_resolve, reject) => {
        cancellation.addEventListener("abort", () => reject(new Error("Import cancelled")), {
          once: true,
        });
      });
    },
  });
  const message = {
    content: "!music add https://youtube.com/playlist?list=PL_test",
    author: { id: "user" },
    guild: {
      id: "123",
      members: {
        fetch: async () => ({ voice: { channel: { id: "voice", type: ChannelType.GuildVoice } } }),
      },
    },
    reply: async () => {},
  } as unknown as Message;
  try {
    const command = music.handle(message);
    await started;
    const stopped = music.stop();
    expect(signal.aborted).toBe(true);
    expect(music.stop()).toBe(stopped);
    await stopped;
    await command;
    expect(await Bun.file(resolvePath("music_123.json", directory)).exists()).toBe(false);
  } finally {
    await music.stop();
  }
});

test("playlist metadata is cached, paginated and does not block music controls", async () => {
  const directory = await temporaryDirectory("music-list-metadata-");
  const urls = Array.from({ length: 12 }, (_, i) => `https://soundcloud.com/artist/track-${i}`);
  await Bun.write(resolvePath("music_listing.json", directory), JSON.stringify([...urls, urls[0]]));
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let started!: () => void;
  const entered = new Promise<void>((resolve) => {
    started = resolve;
  });
  let calls = 0,
    active = 0,
    peak = 0;
  const music = createDiscordMusic(directory, {
    loadMetadata: async (url) => {
      calls++;
      active++;
      peak = Math.max(peak, active);
      started();
      await gate;
      active--;
      if (url.endsWith("track-3")) throw new Error("Unavailable");
      return { title: `Artist — ${"Long title ".repeat(18)}`, duration: 3723, live: false };
    },
  });
  const pages: string[] = [];
  const message = (command: string, replies: string[]) =>
    ({
      content: `!music ${command}`,
      author: { id: "user" },
      guild: {
        id: "listing",
        members: {
          fetch: async () => ({
            voice: { channel: { id: "voice", type: ChannelType.GuildVoice } },
          }),
        },
      },
      reply: async (payload: { content: string }) => {
        replies.push(payload.content);
      },
    }) as unknown as Message;
  try {
    const listing = music.handle(message("list", pages));
    await entered;
    const controls: string[] = [];
    await music.handle(message("repeat", controls));
    expect(controls.at(-1)).toContain("одного трека");
    release();
    await listing;
    expect(peak).toBeLessThanOrEqual(3);
    expect(calls).toBe(12);
    expect(pages.length).toBeGreaterThan(1);
    expect(pages.every((page) => page.length <= 1900)).toBe(true);
    expect(pages.join("\n")).toContain("13. [Artist");
    expect(pages.join("\n")).toContain("1:02:03");
    expect(pages.join("\n")).toContain(
      "4. [Трек](<https://soundcloud.com/artist/track-3>) · длительность неизвестна",
    );
    pages.length = 0;
    await music.handle(message("list", pages));
    expect(calls).toBe(12);
    const queue: string[] = [];
    await music.handle(message("queue", queue));
    expect(queue).toEqual(["Очередь пуста."]);
  } finally {
    release();
    await music.stop();
  }
});
