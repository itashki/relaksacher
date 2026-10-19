/** @file Guild playlist switching and deletion confirmation regression coverage. */
import { expect, spyOn, test } from "bun:test";
import {
  ChannelType,
  type Guild,
  type Interaction,
  type APIButtonComponent,
  type APIStringSelectComponent,
  type ModalBuilder,
} from "discord.js";
import { createDiscordMusic } from "../src/adapters/discord-music.ts";
import type { MusicLibrary } from "../src/adapters/music-library.ts";
import { temporaryDirectory } from "./temp.ts";

/** Exercise commands and Discord controls with a shared guild and captured replies. */
async function fixture() {
  const directory = await temporaryDirectory("music-playlists-");
  const replies: Parameters<
    Parameters<ReturnType<typeof createDiscordMusic>["handle"]>[0]["reply"]
  >[0][] = [];
  let voice = true;
  const modals: ModalBuilder[] = [];
  const events: string[] = [];
  const queries: string[] = [];
  let transferText = "";
  const guild = (id = "guild") =>
    ({
      id,
      members: {
        fetch: async () => ({
          voice: { channel: voice ? { id: "voice", type: ChannelType.GuildVoice } : null },
        }),
      },
    }) as unknown as Guild;
  const options = {
    loadMetadata: async () => ({ title: "Song", duration: 120, live: false }),
    downloadPlaylistFile: async () => transferText,
    loadPlaylist: async () => ({
      tracks: ["https://www.youtube.com/watch?v=abcdefghijk"],
      skipped: 0,
      truncated: false,
    }),
    search: async (query: string) => {
      queries.push(query);
      return [{ title: "Найденный трек", url: "https://youtu.be/found", duration: 90 }];
    },
  };
  let music = createDiscordMusic(directory, options);
  const reply = async (payload: (typeof replies)[number]) => {
    expect(
      payload.components?.some((row) =>
        row
          .toJSON()
          .components.some((item) => "custom_id" in item && item.custom_id === "music:dismiss"),
      ),
    ).toBe(true);
    replies.push(payload);
  };
  const command = (
    content: string,
    user = "owner",
    id = "guild",
    files: { url: string; size: number }[] = [],
  ) =>
    music.handle({
      content: `!music ${content}`,
      guild: guild(id),
      author: { id: user },
      reply,
      attachments: { values: () => files.values() },
    });
  const interaction = (
    customId: string,
    {
      user = "owner",
      id = "guild",
      value,
      modal = false,
      privateMessage = false,
    }: {
      user?: string;
      id?: string;
      value?: string;
      modal?: boolean;
      privateMessage?: boolean;
    } = {},
  ) =>
    music.handleInteraction({
      customId,
      guild: guild(id),
      user: { id: user },
      message: privateMessage ? { id: "private", flags: { has: () => true } } : undefined,
      isButton: () => value === undefined && !modal,
      isModalSubmit: () => modal,
      isStringSelectMenu: () => value !== undefined && !modal,
      values: value === undefined ? [] : [value],
      fields: { getTextInputValue: () => value ?? "" },
      reply: async (payload: (typeof replies)[number]) => {
        events.push("reply");
        await reply(payload);
      },
      editReply: async (payload: (typeof replies)[number]) => {
        events.push("edit");
        await reply(payload);
      },
      followUp: async (payload: (typeof replies)[number]) => {
        events.push("followUp");
        await reply(payload);
      },
      deferReply: async () => {
        events.push("deferReply");
      },
      deferUpdate: async () => {
        events.push("deferUpdate");
      },
      deleteReply: async () => {
        events.push("delete");
      },
      showModal: async (modal: ModalBuilder) => {
        modals.push(modal);
      },
    } as unknown as Interaction);
  const library = async (id = "guild"): Promise<MusicLibrary> =>
    Bun.file(`${directory}/music_${id}.json`).json();
  const controls = () =>
    replies
      .at(-1)!
      .components!.flatMap<APIButtonComponent | APIStringSelectComponent>(
        (row) => row.toJSON().components,
      );
  const confirmation = () => {
    const button = controls().find(
      (item) => "custom_id" in item && item.custom_id?.startsWith("music:playlist-confirm:"),
    );
    if (!button || !("custom_id" in button)) throw new Error("Missing confirmation");
    return button.custom_id!;
  };
  return {
    replies,
    command,
    interaction,
    library,
    controls,
    confirmation,
    modals,
    events,
    queries,
    importFile: (text: string, name = "", id = "guild") => {
      transferText = text;
      return command(`playlist import ${name}`, "owner", id, [
        {
          url: "https://cdn.discordapp.com/attachments/channel/file/playlist.json",
          size: text.length,
        },
      ]);
    },
    setVoice: (value: boolean) => {
      voice = value;
    },
    restart: async () => {
      await music.stop();
      music = createDiscordMusic(directory, options);
    },
    stop: () => music.stop(),
  };
}

test("named playlists isolate edits, persist selection and support menu switching and names with spaces", async () => {
  const f = await fixture();
  try {
    await f.command("add https://youtu.be/one");
    const original = (await f.library()).activeId;
    await f.command("playlist create Для работы");
    expect((await f.library()).activeId).toBe(original);
    await f.command("playlist use Для работы");
    await f.command("add https://youtu.be/two");
    await f.command("playlist rename Спокойная музыка");
    await f.restart();
    await f.command("playlists");
    expect(f.replies.at(-1)!.content).toContain("Спокойная музыка");
    expect(f.controls().filter((item) => "options" in item)).toHaveLength(1);
    expect(f.controls().filter((item) => "options" in item)[0]).toMatchObject({
      options: [
        { label: "Основной", value: original, default: false },
        { label: "Спокойная музыка", default: true },
      ],
    });
    const activeBeforeSelection = (await f.library()).activeId;
    await f.interaction("music:library-manage", { value: original });
    expect((await f.library()).activeId).toBe(activeBeforeSelection);
    expect(
      f
        .controls()
        .find(
          (item) => "custom_id" in item && item.custom_id === `music:library-activate:${original}`,
        ),
    ).toMatchObject({ label: "Сделать активным", disabled: false });
    f.setVoice(false);
    await f.interaction(`music:library-activate:${original}`);
    expect((await f.library()).activeId).toBe(activeBeforeSelection);
    f.setVoice(true);
    await f.interaction(`music:library-activate:${original}`);
    expect((await f.library()).activeId).toBe(original);
    await f.command("remove 1");
    const saved = await f.library();
    expect(saved.playlists.map((item) => item.tracks)).toEqual([[], ["https://youtu.be/two"]]);
    await f.command("playlist use спокойная музыка");
    expect((await f.library()).activeId).toBe(saved.playlists[1].id);
    await f.command("playlist create ОСНОВНОЙ");
    expect(f.replies.at(-1)!.content).toContain("уже существует");
    await f.command("playlist rename Основной");
    expect(f.replies.at(-1)!.content).toContain("уже существует");
    await f.command("playlist create " + "x".repeat(61));
    expect(f.replies.at(-1)!.content).toContain("от 1 до 60");
    await f.command("playlist use missing");
    expect(f.replies.at(-1)!.content).toContain("не найден");
    f.setVoice(false);
    await f.command("playlist create Запрещённый");
    expect(f.replies.at(-1)!.content).toContain("войдите");
    await f.command("playlists");
    expect(f.replies.at(-1)!.content).toContain("Плейлисты сервера");
    expect((await f.library()).playlists).toHaveLength(2);
  } finally {
    await f.stop();
  }
});

test("exported files transfer named playlists between guilds without sharing IDs or replacing existing tracks", async () => {
  const f = await fixture();
  try {
    await f.command("playlist create Для переноса");
    await f.command("playlist add Для переноса https://youtu.be/one");
    await f.command("playlist add Для переноса https://youtu.be/one");
    const source = await f.library();
    f.setVoice(false);
    await f.interaction(`music:library-export:${source.playlists[1].id}`);
    const attachment = f.replies.at(-1)!.files![0];
    expect(attachment.name).toBe("playlist.json");
    expect(Buffer.isBuffer(attachment.attachment)).toBe(true);
    const text = attachment.attachment.toString();
    const portable = JSON.parse(text);
    expect(portable).toEqual({
      format: "relaksacher-playlist",
      version: 1,
      name: "Для переноса",
      tracks: ["https://youtu.be/one", "https://youtu.be/one"],
    });
    await f.importFile(text, "", "other-guild");
    expect(f.replies.at(-1)!.content).toContain("войдите");
    f.setVoice(true);
    await f.importFile(text, "", "other-guild");
    const imported = await f.library("other-guild");
    expect(imported.playlists).toHaveLength(2);
    expect(imported.playlists[1]).toMatchObject({ name: portable.name, tracks: portable.tracks });
    expect(imported.activeId).toBe(imported.playlists[0].id);
    expect(imported.playlists[1].id).not.toBe(source.playlists[1].id);
    expect(imported.playlists[0].tracks).toEqual([]);
    await f.importFile(text, "", "other-guild");
    expect(f.replies.at(-1)!.content).toContain("уже существует");
    expect(await f.library("other-guild")).toEqual(imported);
    await f.importFile(text, "Копия с новым именем", "other-guild");
    expect((await f.library("other-guild")).playlists[2].name).toBe("Копия с новым именем");
    expect(await f.library()).toEqual(source);
    await f.restart();
    await f.command("playlist export Копия с новым именем", "owner", "other-guild");
    expect(f.replies.at(-1)!.files).toHaveLength(1);
    await f.command("playlist export missing");
    expect(f.replies.at(-1)!.content).toContain("не найден");
  } finally {
    await f.stop();
  }
});

test("invalid playlist imports leave the existing library unchanged", async () => {
  const f = await fixture();
  try {
    await f.command("add https://youtu.be/one");
    const before = await f.library();
    await f.command("playlist import");
    expect(f.replies.at(-1)!.content).toContain("Прикрепите один JSON-файл");
    for (const text of [
      "not json",
      "null",
      JSON.stringify({
        format: "relaksacher-playlist",
        version: 1,
        name: "Импорт",
        tracks: ["https://youtu.be/valid", "file:///etc/passwd"],
      }),
    ]) {
      await f.importFile(text);
      expect(await f.library()).toEqual(before);
    }
  } finally {
    await f.stop();
  }
});

test("management menus and named commands edit inactive playlists without changing selection", async () => {
  const f = await fixture();
  try {
    await f.command("add https://youtu.be/current");
    const before = await f.library();
    await f.command("playlist create Для работы");
    const target = (await f.library()).playlists[1];
    await f.command("playlist rename Для работы | Фоновая музыка");
    await f.command("playlist add Фоновая музыка https://youtu.be/one");
    await f.command("playlist add Фоновая музыка https://youtube.com/playlist?list=PL_test");
    await f.command("playlists");
    const menu = f
      .controls()
      .find((item) => "custom_id" in item && item.custom_id === "music:library-manage");
    expect(menu).toBeDefined();
    await f.interaction("music:library-manage", { value: target.id });
    expect(f.replies.at(-1)!.content).toContain("Фоновая музыка");
    const addButton = f
      .controls()
      .find((item) => "custom_id" in item && item.custom_id === `music:library-add:${target.id}`);
    expect(addButton).toBeDefined();
    await f.interaction(`music:library-add:${target.id}`);
    expect(f.modals.at(-1)!.toJSON().title).toBe("Добавить треки");
    await f.interaction(`music:library-add:${target.id}`, {
      value: "https://youtu.be/two",
      modal: true,
    });
    await f.interaction(`music:library-rename:${target.id}`, { value: "Новое имя", modal: true });
    let saved = await f.library();
    expect(saved.activeId).toBe(before.activeId);
    expect(saved.playlists[0]).toEqual(before.playlists[0]);
    expect(saved.playlists[1]).toEqual({
      id: target.id,
      name: "Новое имя",
      tracks: [
        "https://youtu.be/one",
        "https://www.youtube.com/watch?v=abcdefghijk",
        "https://youtu.be/two",
      ],
    });
    await f.interaction(`music:library-export:${target.id}`);
    const text = f.replies.at(-1)!.files![0].attachment.toString();
    await f.importFile(text, "Импортированная копия");
    saved = await f.library();
    expect(saved.activeId).toBe(before.activeId);
    expect(saved.playlists[2].tracks).toEqual(saved.playlists[1].tracks);
    await f.interaction(`music:library-delete:${target.id}`);
    await f.interaction(f.confirmation());
    saved = await f.library();
    expect(saved.activeId).toBe(before.activeId);
    expect(saved.playlists.some((item) => item.id === target.id)).toBe(false);
    const snapshot = structuredClone(saved);
    await f.interaction(`music:library-add:${target.id}`, {
      value: "https://youtu.be/stale",
      modal: true,
    });
    expect(f.replies.at(-1)!.content).toContain("не найден");
    expect(await f.library()).toEqual(snapshot);
    await f.restart();
    await f.command("list");
    expect((await f.library()).activeId).toBe(before.activeId);
    expect(f.replies.at(-1)!.content).toContain("https://youtu.be/current");
    await f.command("help");
    expect(f.replies.at(-1)!.content.length).toBeLessThanOrEqual(2000);
  } finally {
    await f.stop();
  }
});

test("inactive playlist search and back navigation replace private screens without changing the active selection", async () => {
  const f = await fixture();
  try {
    await f.command("playlist create Для поиска");
    const saved = await f.library();
    const target = saved.playlists[1];
    await f.interaction("music:library-manage", { value: target.id, privateMessage: true });
    expect(f.events.splice(0)).toEqual(["deferUpdate", "edit"]);
    expect(
      f
        .controls()
        .some(
          (item) => "custom_id" in item && item.custom_id === `music:library-search:${target.id}`,
        ),
    ).toBe(true);
    await f.interaction(`music:library-search:${target.id}`, { privateMessage: true });
    expect(f.modals.at(-1)!.toJSON().title).toBe("Поиск музыки");
    expect(f.events.splice(0)).toEqual([]);
    await f.interaction(`music:library-search:${target.id}`, {
      value: "sc: test song",
      modal: true,
      privateMessage: true,
    });
    expect(f.events.splice(0)).toEqual(["deferUpdate", "edit"]);
    expect(f.queries).toEqual(["sc: test song"]);
    expect(f.replies.at(-1)!.content).toContain("Для поиска");
    const menu = f
      .controls()
      .find((item) => "custom_id" in item && item.custom_id?.startsWith("music:pick:"));
    if (!menu || !("custom_id" in menu)) throw new Error("Missing search choices");
    await f.interaction(menu.custom_id!, { value: "0", privateMessage: true });
    expect(f.events.splice(0)).toEqual(["deferUpdate", "edit"]);
    expect((await f.library()).playlists[1].tracks).toEqual(["https://youtu.be/found"]);
    expect((await f.library()).activeId).toBe(saved.activeId);
    expect((await f.library()).playlists[0]).toEqual(saved.playlists[0]);
    expect(
      f
        .controls()
        .some((item) => "custom_id" in item && item.custom_id === `music:back:manage:${target.id}`),
    ).toBe(true);
    await f.interaction(`music:back:manage:${target.id}`, { privateMessage: true });
    expect(f.events.splice(0)).toEqual(["deferUpdate", "edit"]);
    expect(f.replies.at(-1)!.content).toContain("Для поиска");
    await f.interaction("music:back:playlists", { privateMessage: true });
    expect(f.events.splice(0)).toEqual(["deferUpdate", "edit"]);
    expect(f.replies.at(-1)!.content).toContain("Плейлисты сервера");
    await f.interaction("music:back:panel", { privateMessage: true });
    expect(f.events.splice(0)).toEqual(["deferUpdate", "edit"]);
    expect(f.replies.at(-1)!.content).toContain("Музыкальный плеер");
    await f.interaction("music:playlists");
    expect(f.events.splice(0)).toEqual(["deferReply", "edit"]);
  } finally {
    await f.stop();
  }
});

test("playlist forms retain their target when the active playlist changes", async () => {
  const f = await fixture();
  try {
    await f.interaction("music:library-create");
    expect(f.modals.at(-1)!.toJSON().custom_id).toBe("music:library-create");
    await f.interaction("music:library-create", { value: "Из формы", modal: true });
    const original = (await f.library()).activeId;
    const selected = (await f.library()).playlists[1].id;
    await f.interaction(`music:library-rename:${selected}`);
    expect(f.modals.at(-1)!.toJSON().title).toContain("Переименовать");
    await f.interaction(`music:library-rename:${selected}`, { value: "Новое имя", modal: true });
    expect((await f.library()).playlists[1].name).toBe("Новое имя");
    await f.command("playlist use Новое имя");
    await f.interaction(`music:library-rename:${selected}`, {
      value: "Устаревшее имя",
      modal: true,
    });
    expect(f.replies.at(-1)!.content).toContain("переименован");
    expect((await f.library()).playlists.map((item) => item.name)).toEqual([
      "Основной",
      "Устаревшее имя",
    ]);
    await f.command("playlist use Основной");
    await f.interaction(`music:library-delete:${selected}`);
    expect(f.replies.at(-1)!.content).toContain("Вы уверены");
    expect((await f.library()).playlists).toHaveLength(2);
    expect((await f.library()).activeId).toBe(original);
  } finally {
    await f.stop();
  }
});

test("playlist form buttons explain missing voice access and open normally after joining", async () => {
  const f = await fixture();
  try {
    f.setVoice(false);
    for (const action of ["create", "rename", "delete"]) {
      await f.interaction(`music:library-${action}`);
      expect(f.replies.at(-1)!.content).toBe("Сначала войдите в обычный голосовой канал.");
    }
    expect(f.modals).toHaveLength(0);
    f.setVoice(true);
    await f.interaction("music:library-create");
    expect(f.modals).toHaveLength(1);
    expect(f.modals[0].toJSON().title).toBe("Создать плейлист");
    await f.interaction("music:library-create", { value: "Новый", modal: true });
    expect((await f.library()).playlists[1].name).toBe("Новый");
  } finally {
    await f.stop();
  }
});

test("expired confirmations cannot delete a playlist and library capacity is bounded", async () => {
  const f = await fixture();
  try {
    await f.command("playlist create Второй");
    await f.command("playlist delete");
    const confirm = f.confirmation();
    const now = spyOn(Date, "now").mockReturnValue(Date.now() + 300_001);
    try {
      await f.interaction(confirm);
      expect(f.replies.at(-1)!.content).toContain("Подтверждение недоступно");
      expect((await f.library()).playlists).toHaveLength(2);
    } finally {
      now.mockRestore();
    }
    for (let i = 2; i < 25; i++) await f.command(`playlist create Плейлист ${i}`);
    await f.command("playlist create Лишний");
    expect(f.replies.at(-1)!.content).toContain("уже 25 плейлистов");
    expect((await f.library()).playlists).toHaveLength(25);
    await f.command("playlists");
    const select = f.controls().find((item) => "options" in item)!;
    if (!("options" in select)) throw new Error("Missing library menu");
    expect(select.options).toHaveLength(25);
    expect(f.replies.at(-1)!.content.length).toBeLessThan(2000);
  } finally {
    await f.stop();
  }
});

test("deletion requires owner confirmation, supports cancellation and selects a surviving playlist", async () => {
  const f = await fixture();
  try {
    await f.command("playlist create Удаляемый");
    await f.command("playlist use Удаляемый");
    await f.command("add https://youtu.be/one");
    await f.command("playlist delete");
    const confirm = f.confirmation();
    expect((await f.library()).playlists).toHaveLength(2);
    await f.interaction(confirm, { user: "other" });
    expect(f.replies.at(-1)!.content).toContain("Подтверждение недоступно");
    await f.interaction(confirm, { id: "other-guild" });
    expect(f.replies.at(-1)!.content).toContain("Подтверждение недоступно");
    f.setVoice(false);
    await f.interaction(confirm);
    expect(f.replies.at(-1)!.content).toContain("войдите");
    f.setVoice(true);
    await f.interaction(confirm.replace("playlist-confirm", "playlist-cancel"));
    expect(f.replies.at(-1)!.content).toContain("отменено");
    await f.interaction(confirm);
    expect(f.replies.at(-1)!.content).toContain("Подтверждение недоступно");
    await f.command("playlist delete");
    await f.interaction(f.confirmation());
    expect(f.replies.at(-1)!.content).toContain("удалён");
    const saved = await f.library();
    expect(saved.playlists).toHaveLength(1);
    expect(saved.activeId).toBe(saved.playlists[0].id);
    await f.command("playlist delete");
    expect(f.replies.at(-1)!.content).toContain("последний");
    await f.restart();
    await f.command("playlists");
    expect(f.replies.at(-1)!.content).toContain("Основной");
  } finally {
    await f.stop();
  }
});

test("changed playlists invalidate confirmation and track menus even when another playlist has identical tracks", async () => {
  const f = await fixture();
  try {
    await f.command("add https://youtu.be/one");
    await f.command("list");
    const jump = f.controls().find((item) => "options" in item)!;
    if (!("custom_id" in jump)) throw new Error("Missing jump menu");
    await f.command("playlist create Второй");
    await f.command("playlist use Второй");
    await f.command("add https://youtu.be/one");
    await f.interaction(jump.custom_id!, { value: "0" });
    expect(f.replies.at(-1)!.content).toContain("Плейлист изменился");
    await f.command("playlist delete");
    const confirm = f.confirmation();
    await f.command("add https://youtu.be/two");
    await f.interaction(confirm);
    expect(f.replies.at(-1)!.content).toContain("Плейлист изменился");
    expect((await f.library()).playlists).toHaveLength(2);
    await f.command("playlist delete Основной");
    const other = f.confirmation();
    await f.interaction(other);
    expect((await f.library()).playlists[0].name).toBe("Второй");
  } finally {
    await f.stop();
  }
});
