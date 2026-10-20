/** @file Mixed English/Russian music aliases preserve arguments and normalize context-specific operations. */
import { expect, test } from "bun:test";
import { isMusicCommand, parseMusicCommand } from "../../src/adapters/discord/music/commands.ts";
import { createDiscordMusic } from "../../src/adapters/discord/music/index.ts";
import { ChannelType, type Guild } from "discord.js";
import { temporaryDirectory } from "../support/temp.ts";

test("prefixes and command words can be freely mixed in either language", () => {
  for (const prefix of ["music", "музыка", "МУЗЫКА"]) {
    for (const [word, command] of [
      ["add", "add"],
      ["добавить", "add"],
      ["поиск", "search"],
      ["помощь", "help"],
      ["панель", "panel"],
      ["список", "list"],
      ["играть", "play"],
      ["пауза", "pause"],
      ["продолжить", "resume"],
      ["пропустить", "skip"],
      ["стоп", "stop"],
      ["выйти", "leave"],
      ["очередь", "queue"],
      ["перейти", "jump"],
      ["удалить", "remove"],
      ["повтор", "repeat"],
      ["случайно", "shuffle"],
      ["перемешать", "mix"],
      ["плейлисты", "playlists"],
    ]) {
      const input = `  !${prefix} ${word} Artist Ёж https://youtu.be/AbCd?x=X  `;
      expect(isMusicCommand(input)).toBe(true);
      expect(parseMusicCommand(input)).toEqual({
        command,
        argument: "Artist Ёж https://youtu.be/AbCd?x=X",
      });
    }
    expect(parseMusicCommand(`!${prefix}`)).toEqual({ command: "panel", argument: "" });
  }
  for (const input of ["!музыкант", "!musical add", "hello !музыка", "!музыкаadd", "музыка"])
    expect(parseMusicCommand(input)).toBeNull();
});

test("mixed aliases edit the same stored playlists and bilingual help fits Discord messages", async () => {
  const directory = await temporaryDirectory("music-aliases-");
  const music = createDiscordMusic(directory);
  const replies: string[] = [];
  let voice = true;
  const guild = {
    id: "aliases",
    members: {
      fetch: async () => ({
        voice: { channel: voice ? { id: "voice", type: ChannelType.GuildVoice } : null },
      }),
    },
  } as unknown as Guild;
  const send = (content: string) =>
    music.handle({
      content,
      guild,
      author: { id: "user" },
      reply: async (payload) => {
        replies.push(payload.content);
      },
    });
  const library = () => Bun.file(`${directory}/music_aliases.json`).json();
  try {
    await send("!музыка плейлист create Мои Треки");
    await send("!music playlist добавить Мои Треки https://youtu.be/AbCdEfGhIjK");
    await send("!МУЗЫКА плейлист переименовать Мои Треки | всё");
    const saved = await library();
    expect(saved.playlists[1]).toMatchObject({
      name: "всё",
      tracks: ["https://youtu.be/AbCdEfGhIjK"],
    });
    expect(saved.activeId).toBe(saved.playlists[0].id);
    await send("!музыка repeat трек");
    expect(replies.at(-1)).toContain("одного трека");
    await send("!music случайно выкл");
    expect(replies.at(-1)).toContain("выключен");
    voice = false;
    await send("!музыка add https://youtu.be/denied");
    expect(replies.at(-1)).toContain("войдите");
    expect(await library()).toEqual(saved);
    replies.length = 0;
    await send("!музыка помощь");
    expect(replies.join("\n")).toContain("!музыка add");
    expect(replies.every((page) => page.length <= 2000)).toBe(true);
  } finally {
    await music.stop();
  }
});

test("playlist operations and playback mode arguments have context-specific aliases", () => {
  for (const playlist of ["playlist", "плейлист"]) {
    for (const [word, operation] of [
      ["создать", "create"],
      ["create", "create"],
      ["выбрать", "use"],
      ["управление", "manage"],
      ["переименовать", "rename"],
      ["удалить", "delete"],
      ["добавить", "add"],
      ["поиск", "search"],
      ["экспорт", "export"],
      ["импорт", "import"],
    ])
      expect(parseMusicCommand(`!музыка ${playlist} ${word} Мой Плейлист`)).toEqual({
        command: "playlist",
        argument: `${operation} Мой Плейлист`,
      });
  }
  expect(parseMusicCommand("!музыка повтор всё")).toEqual({ command: "repeat", argument: "all" });
  expect(parseMusicCommand("!music repeat трек")).toEqual({ command: "repeat", argument: "track" });
  expect(parseMusicCommand("!музыка shuffle вкл")).toEqual({ command: "shuffle", argument: "on" });
  expect(parseMusicCommand("!музыка плейлист создать всё")).toEqual({
    command: "playlist",
    argument: "create всё",
  });
  expect(parseMusicCommand("!музыка поиск sc: Удалить всё")).toEqual({
    command: "search",
    argument: "sc: Удалить всё",
  });
});
