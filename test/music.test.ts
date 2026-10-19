/** @file Regression coverage for music behavior and its external boundaries. */
import { test, expect } from "bun:test";
import { temporaryDirectory } from "./temp.ts";
import { resolvePath } from "../src/core/paths.ts";
import { createDiscordMusic, musicUrl } from "../src/adapters/discord-music.ts";
import type { Message } from "discord.js";
import { ChannelType } from "discord.js";

test("music accepts only supported HTTPS source URLs", () => {
  expect(musicUrl("<https://youtu.be/abc>")).toBe("https://youtu.be/abc");
  expect(musicUrl("https://soundcloud.com/artist/track")).toContain("soundcloud.com");
  for (const url of [
    "file:///etc/passwd",
    "https://localhost/x",
    "https://youtube.com.evil.org/x",
    "http://youtube.com/x",
    "https://user:pass@youtube.com/x",
  ])
    expect(() => musicUrl(url)).toThrow();
});

test("music serializes playlist edits and restores them after restart", async () => {
  const directory = resolvePath("new/nested #memory%", await temporaryDirectory("music-test-"));
  let music = createDiscordMusic(directory);
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
      music.handle(message("!music add https://youtu.be/one")),
      music.handle(message("!music add https://soundcloud.com/a/b")),
    ]);
    music.stop();
    music = createDiscordMusic(directory);
    await music.handle(message("!music list", false));
    expect(replies.at(-1)).toContain("1. <https://youtu.be/one>");
    expect(replies.at(-1)).toContain("2. <https://soundcloud.com/a/b>");
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

test("YouTube playlist extraction canonicalizes watch links, bounds imports and filters entries", async () => {
  const { loadYouTubePlaylist, youtubePlaylistUrl } =
    await import("../src/adapters/discord-music.ts");
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
    await music.handle(message("!music add https://youtube.com/watch?v=abcdefghijk&list=PL_test"));
    expect(replies.at(-1)).toContain("Добавлено треков: 2");
    expect(replies.at(-1)).toContain("начальная часть");
    expect(replies.at(-1)).toContain("пропущено: 1");
    fail = true;
    await music.handle(message("!music add https://youtube.com/playlist?list=PL_test"));
    expect(replies.at(-1)).toBe("Playlist unavailable");
    expect(await Bun.file(resolvePath("music_456.json", directory)).json()).toEqual([
      "https://youtu.be/one",
      "https://www.youtube.com/watch?v=abcdefghijk",
      "https://www.youtube.com/watch?v=zyxwvutsrqp",
    ]);
  } finally {
    music.stop();
  }
});

test("music panel buttons, modal submissions and voice checks share command behavior", async () => {
  const directory = await temporaryDirectory("music-controls-test-");
  const music = createDiscordMusic(directory);
  type Payload = {
    content?: string;
    components?: import("discord.js").ActionRowBuilder<import("discord.js").ButtonBuilder>[];
    flags?: number;
  };
  const posted: Payload[] = [],
    edits: Payload[] = [];
  let inVoice = true;
  let voiceType = ChannelType.GuildVoice;
  const guild = {
    id: "789",
    members: {
      fetch: async () => ({
        voice: { channel: inVoice ? { id: "voice", type: voiceType } : null },
      }),
    },
  };
  const panelMessage = {
    id: "panel",
    edit: async (payload: Payload) => {
      edits.push(payload);
    },
  };
  const request = (content: string) =>
    ({
      content,
      author: { id: "user" },
      guild,
      reply: async (payload: Payload) => {
        posted.push(payload);
        return panelMessage;
      },
    }) as unknown as Message;
  const responses: Payload[] = [],
    calls: string[] = [];
  let modal: import("discord.js").ModalBuilder;
  const interaction = (action: string, value?: string) =>
    ({
      customId: `music:${action}`,
      guild,
      user: { id: "user" },
      message: panelMessage,
      isButton: () => value === undefined,
      isModalSubmit: () => value !== undefined,
      fields: { getTextInputValue: () => value },
      showModal: async (payload: import("discord.js").ModalBuilder) => {
        calls.push("modal");
        modal = payload;
      },
      deferReply: async (payload: Payload) => {
        calls.push("defer");
        responses.push(payload);
      },
      editReply: async (payload: Payload) => {
        calls.push("edit");
        responses.push(payload);
      },
      followUp: async (payload: Payload) => {
        responses.push(payload);
      },
      reply: async (payload: Payload) => {
        responses.push(payload);
      },
    }) as unknown as import("discord.js").Interaction;
  try {
    await music.handle(request("!music"));
    expect(posted.at(-1).content).toContain("Музыкальный плеер");
    const buttons = posted
      .at(-1)
      .components.flatMap((row) => row.components.map((button) => button.toJSON()));
    expect(
      buttons.find((button) => "custom_id" in button && button.custom_id === "music:play").disabled,
    ).toBe(true);
    expect(buttons.map((button) => ("custom_id" in button ? button.custom_id : ""))).toEqual([
      "music:play",
      "music:toggle",
      "music:skip",
      "music:stop",
      "music:add",
      "music:remove",
      "music:list",
      "music:panel",
      "music:repeat",
      "music:shuffle",
      "music:mix",
      "music:queue",
    ]);
    await music.handleInteraction(interaction("add"));
    expect(modal.toJSON().custom_id).toBe("music:add");
    expect(calls).toEqual(["modal"]);
    calls.length = 0;
    await music.handleInteraction(interaction("add", "https://youtu.be/abcdefghijk"));
    expect(calls).toEqual(["defer", "edit"]);
    expect(responses.at(-1).content).toContain("Добавлено треков: 1");
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(edits.at(-1).content).toContain("**1/100**");
    expect(edits.at(-1).components[0].components[0].toJSON().disabled).toBe(false);
    await music.handleInteraction(interaction("repeat"));
    expect(responses.at(-1).content).toContain("одного трека");
    await music.handleInteraction(interaction("repeat"));
    expect(responses.at(-1).content).toContain("всей очереди");
    await music.handleInteraction(interaction("shuffle"));
    expect(responses.at(-1).content).toContain("включён");
    await music.handle(request("!music repeat invalid"));
    expect(posted.at(-1).content).toContain("off, track или all");
    await music.handle(request("!music shuffle invalid"));
    expect(posted.at(-1).content).toContain("on или off");
    await music.handle(request("!music"));
    expect(posted.at(-1).content).toContain("вся очередь");
    expect(posted.at(-1).content).toContain("порядок: **вкл**");
    inVoice = false;
    calls.length = 0;
    for (const action of ["add", "remove"]) {
      await music.handleInteraction(interaction(action));
      expect(responses.at(-1).content).toContain("войдите");
      expect(responses.at(-1).flags).toBe(64);
    }
    expect(calls).toEqual([]);
    await music.handleInteraction(interaction("add", "https://youtu.be/abcdefghijk"));
    expect(responses.at(-1).content).toContain("войдите");
    for (const action of ["play", "toggle", "skip", "stop", "repeat", "shuffle", "mix"]) {
      calls.length = 0;
      await music.handleInteraction(interaction(action));
      expect(calls).toEqual(["defer", "edit"]);
      expect(responses.at(-1).content).toContain("войдите");
    }
    await music.handleInteraction(interaction("remove", "1"));
    expect(responses.at(-1).content).toContain("войдите");
    await music.handleInteraction(interaction("list"));
    expect(responses.at(-1).content).toContain("abcdefghijk");
    await music.handleInteraction(interaction("queue"));
    expect(responses.at(-1).content).toBe("Очередь пуста.");
    await music.handleInteraction(interaction("panel"));
    expect(responses.at(-1).content).toContain("Панель обновлена");
    expect(responses.at(-1).components).toBeUndefined();
    inVoice = true;
    voiceType = ChannelType.GuildStageVoice;
    calls.length = 0;
    for (const action of ["add", "remove"]) {
      await music.handleInteraction(interaction(action));
      expect(responses.at(-1).content).toContain("обычный голосовой канал");
    }
    expect(calls).toEqual([]);
    voiceType = ChannelType.GuildVoice;
    await music.handleInteraction(interaction("remove"));
    expect(modal.toJSON().custom_id).toBe("music:remove");
    await music.handleInteraction(interaction("remove", "999"));
    expect(responses.at(-1).content).toContain("Укажите номер трека");
    await music.handleInteraction(interaction("remove", "1"));
    expect(responses.at(-1).content).toContain("Трек удалён");
    await music.handleInteraction(interaction("toggle"));
    expect(responses.at(-1).content).toContain("Сейчас ничего не играет");
    await music.handleInteraction(interaction("skip"));
    expect(responses.at(-1).content).toContain("Сейчас ничего не играет");
    await music.handleInteraction(interaction("play"));
    expect(responses.at(-1).content).toContain("Плейлист пуст");
    await music.handleInteraction(interaction("mix"));
    expect(responses.at(-1).content).toContain("хотя бы два");
    await music.handleInteraction(interaction("stop"));
    expect(responses.at(-1).content).toContain("Музыка остановлена");
    await music.handleInteraction(interaction("repeat"));
    expect(responses.at(-1).content).toContain("выключен");
    await music.handleInteraction(interaction("shuffle"));
    expect(responses.at(-1).content).toContain("выключен");
    for (const [action, value] of [
      ["unknown", undefined],
      ["play", "value"],
    ]) {
      await music.handleInteraction(interaction(action, value));
      expect(responses.at(-1).content).toContain("Неизвестное действие");
      expect(responses.at(-1).flags).toBe(64);
    }
  } finally {
    music.stop();
  }
});

test("music telemetry publishes playlist, import, error and shutdown changes without a Discord panel", async () => {
  const { createMusicMonitor } = await import("../src/core/music-status.ts");
  const directory = await temporaryDirectory("music-monitor-test-");
  const monitor = createMusicMonitor();
  const snapshots: import("../src/core/music-status.ts").MusicStatus[][] = [];
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
    let replay: import("../src/core/music-status.ts").MusicStatus[];
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
