/** @file Regression coverage for Discord music panels, selectors and access checks. */
import { test, expect } from "bun:test";
import { resolvePath } from "../../src/core/paths.ts";
import { temporaryDirectory } from "../support/temp.ts";
import { createDiscordMusic } from "../../src/adapters/discord/music/index.ts";
import type { Message } from "discord.js";
import { ChannelType } from "discord.js";

test("music panel buttons, modal submissions and voice checks share command behavior", async () => {
  const directory = await temporaryDirectory("music-controls-test-");
  const music = createDiscordMusic(directory, {
    loadMetadata: async () => ({ title: "Found track", duration: 245, live: false }),
    search: async () => [
      { title: "Found track", url: "https://www.youtube.com/watch?v=abcdefghijk", duration: 245 },
    ],
  });
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
  const interaction = (action: string, value?: string, select = false) =>
    ({
      customId: `music:${action}`,
      guild,
      user: { id: "user" },
      message: panelMessage,
      isButton: () => !select && value === undefined,
      isModalSubmit: () => !select && value !== undefined,
      isStringSelectMenu: () => select,
      values: select ? [value] : [],
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
      "music:search",
      "music:playlists",
      "music:repeat",
      "music:shuffle",
      "music:mix",
      "music:queue",
      "music:dismiss",
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
    for (const action of ["add", "remove", "search"]) {
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
    expect(responses.at(-1).content).toContain("Неизвестное действие");
    await music.handle(request("!music panel"));
    expect(posted.at(-1).content).toContain("Музыкальный плеер");
    expect(posted.at(-1).components).toHaveLength(4);
    inVoice = true;
    voiceType = ChannelType.GuildStageVoice;
    calls.length = 0;
    for (const action of ["add", "remove", "search"]) {
      await music.handleInteraction(interaction(action));
      expect(responses.at(-1).content).toContain("обычный голосовой канал");
    }
    expect(calls).toEqual([]);
    voiceType = ChannelType.GuildVoice;
    await music.handleInteraction(interaction("remove"));
    expect(responses.at(-1).content).toContain("Удаление треков");
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
    await music.handleInteraction(interaction("search"));
    expect(modal.toJSON().custom_id).toBe("music:search");
    await music.handleInteraction(interaction("search", "artist song"));
    expect(responses.at(-1).content).toContain("Поиск");
    const pick = (
      responses.at(-1).components[0]
        .components[0] as unknown as import("discord.js").StringSelectMenuBuilder
    ).toJSON();
    expect(pick.options[0].label).toContain("Found track");
    expect(pick.options[0].description).toBe("4:05");
    const pickAction = ("custom_id" in pick ? pick.custom_id : "").slice(6);
    const otherUser = interaction(pickAction, "0", true) as unknown as { user: { id: string } };
    otherUser.user = { id: "other-user" };
    await music.handleInteraction(otherUser as unknown as import("discord.js").Interaction);
    expect(responses.at(-1).content).toContain("недоступен");
    inVoice = false;
    await music.handleInteraction(interaction(pickAction, "0", true));
    expect(responses.at(-1).content).toContain("войдите");
    inVoice = true;
    await music.handleInteraction(interaction(pickAction, "0", true));
    expect(responses.at(-1).content).toContain("Добавлено треков: 1");
    await music.handleInteraction(interaction("pick:missing", "0", true));
    expect(responses.at(-1).content).toContain("недоступен");
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

test("removal menu paginates, protects ownership and rejects stale playlist selections", async () => {
  const directory = await temporaryDirectory("music-removal-menu-");
  const tracks = Array.from({ length: 26 }, (_, i) => `https://soundcloud.com/artist/track-${i}`);
  await Bun.write(resolvePath("music_remove-menu.json", directory), JSON.stringify(tracks));
  const music = createDiscordMusic(directory, {
    loadMetadata: async (url) => ({ title: url.split("/").at(-1)!, duration: 65, live: false }),
  });
  const guild = {
    id: "remove-menu",
    members: {
      fetch: async () => ({ voice: { channel: { id: "voice", type: ChannelType.GuildVoice } } }),
    },
  };
  type Payload = {
    content: string;
    components?: {
      toJSON(): {
        components: {
          custom_id?: string;
          options?: { label: string; value: string; description?: string }[];
        }[];
      };
    }[];
  };
  const responses: Payload[] = [];
  const interaction = (customId: string, value?: string, userId = "user") =>
    ({
      customId,
      guild,
      user: { id: userId },
      values: value === undefined ? [] : [value],
      isButton: () => value === undefined,
      isModalSubmit: () => false,
      isStringSelectMenu: () => value !== undefined,
      deferReply: async () => {},
      deferUpdate: async () => {},
      reply: async (payload: Payload) => {
        responses.push(payload);
      },
      editReply: async (payload: Payload) => {
        responses.push(payload);
      },
    }) as unknown as import("discord.js").Interaction;
  try {
    await music.handleInteraction(interaction("music:remove"));
    let menu = responses.at(-1)!;
    expect(menu.content).toContain("1/2");
    expect(menu.components![0].toJSON().components[0].options).toHaveLength(25);
    const next = menu.components![1].toJSON().components[1].custom_id!;
    await music.handleInteraction(interaction(next));
    menu = responses.at(-1)!;
    expect(menu.content).toContain("2/2");
    const select = menu.components![0].toJSON().components[0];
    expect(select.options).toEqual([{ label: "26. track-25", value: "25", description: "1:05" }]);
    await music.handleInteraction(interaction(select.custom_id!, "25", "other-user"));
    expect(responses.at(-1)!.content).toContain("недоступен");
    await music.handleInteraction(interaction(select.custom_id!, "0"));
    expect(responses.at(-1)!.content).toContain("Некорректный выбор");
    await music.handleInteraction(interaction(select.custom_id!, "25"));
    expect(responses.at(-1)!.content).toContain("Трек удалён");
    expect(
      (await Bun.file(resolvePath("music_remove-menu.json", directory)).json()).playlists[0].tracks,
    ).toEqual(tracks.slice(0, 25));
    await music.handleInteraction(interaction(select.custom_id!, "25"));
    expect(responses.at(-1)!.content).toContain("Плейлист изменился");
  } finally {
    await music.stop();
  }
});

test("playlist playback choices cover all entries and enforce ownership, voice and snapshot", async () => {
  const directory = await temporaryDirectory("music-playlist-choice-");
  const tracks = Array.from({ length: 26 }, (_, i) => `https://soundcloud.com/artist/track-${i}`);
  await Bun.write(resolvePath("music_choice.json", directory), JSON.stringify(tracks));
  const music = createDiscordMusic(directory, {
    loadMetadata: async (url) => ({ title: url.split("/").at(-1)!, duration: 123, live: false }),
  });
  let inVoice = false;
  const guild = {
    id: "choice",
    members: {
      fetch: async () => ({
        voice: { channel: inVoice ? { id: "voice", type: ChannelType.GuildVoice } : null },
      }),
    },
  };
  type Payload = {
    content: string;
    components?: import("discord.js").ActionRowBuilder<
      import("discord.js").StringSelectMenuBuilder
    >[];
  };
  const replies: Payload[] = [];
  const request = (content: string) =>
    ({
      content,
      guild,
      author: { id: "user" },
      reply: async (payload: Payload) => {
        replies.push(payload);
      },
    }) as unknown as Message;
  const choose = (customId: string, value: string, user = "user") =>
    ({
      customId,
      guild,
      user: { id: user },
      values: [value],
      isButton: () => false,
      isModalSubmit: () => false,
      isStringSelectMenu: () => true,
      deferReply: async () => {},
      reply: async (payload: Payload) => {
        replies.push(payload);
      },
      editReply: async (payload: Payload) => {
        replies.push(payload);
      },
    }) as unknown as import("discord.js").Interaction;
  try {
    await music.handle(request("!music list"));
    const rows = replies.at(-1)!.components!;
    expect(rows).toHaveLength(3);
    const menu = rows[1].components[0].toJSON();
    expect(menu.options).toEqual([{ label: "26. track-25", value: "25", description: "2:03" }]);
    await music.handleInteraction(choose(menu.custom_id, "25", "other"));
    expect(replies.at(-1)!.content).toContain("недоступен");
    await music.handleInteraction(choose(menu.custom_id, "25"));
    expect(replies.at(-1)!.content).toContain("войдите");
    await music.handleInteraction(choose(menu.custom_id, "0"));
    expect(replies.at(-1)!.content).toContain("Некорректный выбор");
    inVoice = true;
    await music.handle(request("!music remove 1"));
    await music.handleInteraction(choose(menu.custom_id, "25"));
    expect(replies.at(-1)!.content).toContain("Плейлист изменился");
  } finally {
    await music.stop();
  }
});
