/** @file Execute named playlist CRUD, confirmation and JSON import operations. */
import { playlistName, type MusicLibrary } from "../../music/library.ts";
import { musicUrl } from "../../music/url.ts";
import { parsePlaylist } from "../../music/transfer.ts";
import {
  type Guild,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  escapeMarkdown,
} from "discord.js";
import type { MusicRuntime, MusicState } from "./runtime.ts";
import type { MusicRequest } from "./request.ts";

/** Execute a playlist library operation within the owning guild command lock. */
export async function handlePlaylistCommand(
  runtime: MusicRuntime,
  {
    s,
    argument,
    destinationId,
    message,
    guild,
    saveLibrary,
    reply,
    send,
  }: {
    s: MusicState;
    argument: string;
    destinationId?: string;
    message: MusicRequest;
    guild: Guild;
    saveLibrary: (library: MusicLibrary) => Promise<void>;
    reply: (content: string) => Promise<void>;
    send: MusicRequest["reply"];
  },
) {
  const { playlistDeletions, imports, downloadPlaylistFile } = runtime;
  const [, operation = "", rawName = ""] = argument.match(/^(\S+)(?:\s+([\s\S]*))?$/) ?? [];
  const action = operation.toLowerCase();
  const library = s.library;
  const active = library.playlists.find((item) => item.id === library.activeId)!;
  if (action === "import") {
    if (library.playlists.length >= 25) throw new Error("На сервере уже 25 плейлистов.");
    const attachments = [...(message.attachments?.values() ?? [])];
    if (attachments.length !== 1)
      throw new Error(
        "Прикрепите один JSON-файл к сообщению !music playlist import [новое название].",
      );
    const text = await downloadPlaylistFile(attachments[0], imports.signal);
    if (runtime.closed) return;
    const imported = parsePlaylist(text, musicUrl);
    const name = rawName ? playlistName(rawName) : imported.name;
    if (library.playlists.some((item) => item.name.toLowerCase() === name.toLowerCase()))
      throw new Error(
        "Плейлист с таким названием уже существует. Укажите новое: !music playlist import <название> и прикрепите файл.",
      );
    const item = { ...imported, id: crypto.randomUUID(), name };
    await saveLibrary({
      ...library,
      playlists: [...library.playlists, item],
    });
    await reply(`Импортирован плейлист **${escapeMarkdown(name)}**: ${item.tracks.length} треков.`);
    return;
  }
  if (action === "confirm" || action === "cancel") {
    const pending = playlistDeletions.get(rawName);
    if (
      !pending ||
      pending.userId !== message.author.id ||
      pending.guildId !== guild.id ||
      pending.expires <= Date.now()
    )
      throw new Error("Подтверждение недоступно. Запросите удаление заново.");
    playlistDeletions.delete(rawName);
    if (action === "cancel") {
      await reply("Удаление плейлиста отменено.");
      return;
    }
    const target = library.playlists.find((item) => item.id === pending.playlistId);
    if (!target || JSON.stringify(target) !== pending.snapshot)
      throw new Error("Плейлист изменился. Запросите удаление заново.");
    if (library.playlists.length === 1) throw new Error("Нельзя удалить последний плейлист.");
    const playlists = library.playlists.filter((item) => item.id !== target.id);
    await saveLibrary({
      ...library,
      playlists,
      activeId: active.id === target.id ? playlists[0].id : active.id,
    });
    await reply(`Плейлист «${escapeMarkdown(target.name)}» удалён.`);
    return;
  }
  if (action === "create" || action === "rename") {
    const names = action === "rename" && !destinationId ? rawName.split(/\s+\|\s+/) : [rawName];
    if (names.length > 2)
      throw new Error("Используйте !music playlist rename <название> | <новое название>.");
    const target = destinationId
      ? library.playlists.find((item) => item.id === destinationId)
      : names.length === 2
        ? library.playlists.find(
            (item) => item.name.toLowerCase() === names[0].trim().normalize("NFC").toLowerCase(),
          )
        : active;
    if (!target) throw new Error("Плейлист не найден. Используйте !music playlists.");
    const name = playlistName(names.at(-1)!);
    if (
      library.playlists.some(
        (item) =>
          item.name.toLowerCase() === name.toLowerCase() &&
          (action === "create" || item.id !== target.id),
      )
    )
      throw new Error("Плейлист с таким названием уже существует.");
    if (action === "create") {
      if (library.playlists.length >= 25) throw new Error("На сервере уже 25 плейлистов.");
      const item = { id: crypto.randomUUID(), name, tracks: [] as string[] };
      await saveLibrary({
        ...library,
        playlists: [...library.playlists, item],
      });
    } else
      await saveLibrary({
        ...library,
        playlists: library.playlists.map((item) =>
          item.id === target.id ? { ...item, name } : item,
        ),
      });
    await reply(
      `${action === "create" ? "Создан плейлист" : "Плейлист переименован"}: **${escapeMarkdown(name)}**.`,
    );
    return;
  }
  const target = destinationId
    ? library.playlists.find((item) => item.id === destinationId)
    : rawName
      ? library.playlists.find((item) =>
          action === "select"
            ? item.id === rawName
            : item.name.toLowerCase() === rawName.normalize("NFC").toLowerCase(),
        )
      : active;
  if (action === "use" || action === "select") {
    if (!rawName || !target) throw new Error("Плейлист не найден. Используйте !music playlists.");
    await saveLibrary({ ...library, activeId: target.id });
    await reply(`Активный плейлист: **${escapeMarkdown(target.name)}**.`);
    return;
  }
  if (action === "delete") {
    if (!target) throw new Error("Плейлист не найден.");
    if (library.playlists.length === 1) throw new Error("Нельзя удалить последний плейлист.");
    for (const [token, pending] of playlistDeletions)
      if (pending.expires <= Date.now()) playlistDeletions.delete(token);
    while (playlistDeletions.size >= 100)
      playlistDeletions.delete(playlistDeletions.keys().next().value!);
    const token = crypto.randomUUID();
    playlistDeletions.set(token, {
      userId: message.author.id,
      guildId: guild.id,
      playlistId: target.id,
      snapshot: JSON.stringify(target),
      expires: Date.now() + 300_000,
    });
    await send({
      content: `Вы уверены, что хотите удалить плейлист «${escapeMarkdown(target.name)}» (${target.tracks.length} треков)? Это действие нельзя отменить.`,
      components: [
        new ActionRowBuilder<ButtonBuilder>().addComponents(
          new ButtonBuilder()
            .setCustomId(`music:playlist-confirm:${token}`)
            .setLabel("Да, удалить плейлист")
            .setStyle(ButtonStyle.Danger),
          new ButtonBuilder()
            .setCustomId(`music:playlist-cancel:${token}`)
            .setLabel("Отмена")
            .setStyle(ButtonStyle.Secondary),
        ),
      ],
      allowedMentions: { parse: [], repliedUser: false },
    });
    return;
  }
  throw new Error(
    "Используйте !music playlist create|use|manage|rename|delete|add|export|import <название>.",
  );
}
