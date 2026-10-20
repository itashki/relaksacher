/** @file Render named playlist menus and exports without requiring voice access. */
import {
  ActionRowBuilder,
  AttachmentBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
  escapeMarkdown,
} from "discord.js";
import { exportPlaylist } from "../../music/transfer.ts";
import type { MusicState } from "./runtime.ts";
import type { MusicRequest } from "./request.ts";

/** Send read-only library screens, returning false for unrelated commands. */
export async function showMusicLibrary(
  command: string,
  argument: string,
  message: MusicRequest,
  s: MusicState,
  send: MusicRequest["reply"],
): Promise<boolean> {
  if (command === "playlists" || (command === "playlist" && !argument)) {
    await send({
      content: `**Плейлисты сервера (${s.library.playlists.length}/25)**\nАктивный: **${escapeMarkdown(s.library.playlists.find((item) => item.id === s.library.activeId)!.name)}**`,
      components: [
        new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
          new StringSelectMenuBuilder()
            .setCustomId("music:library-manage")
            .setPlaceholder("Выберите плейлист")
            .addOptions(
              s.library.playlists.map((item) => ({
                label: item.name,
                value: item.id,
                default: item.id === s.library.activeId,
                description: `Треков: ${item.tracks.length}`,
              })),
            ),
        ),
        new ActionRowBuilder<ButtonBuilder>().addComponents(
          new ButtonBuilder()
            .setCustomId("music:library-create")
            .setLabel("Создать")
            .setStyle(ButtonStyle.Success),
          new ButtonBuilder()
            .setCustomId(`music:library-rename:${s.library.activeId}`)
            .setLabel("Переименовать активный")
            .setStyle(ButtonStyle.Secondary),
          new ButtonBuilder()
            .setCustomId(`music:library-delete:${s.library.activeId}`)
            .setLabel("Удалить активный")
            .setStyle(ButtonStyle.Danger)
            .setDisabled(s.library.playlists.length === 1),
          new ButtonBuilder()
            .setCustomId(`music:library-export:${s.library.activeId}`)
            .setLabel("Экспорт активного")
            .setStyle(ButtonStyle.Secondary),
        ),
      ],
      allowedMentions: { parse: [], repliedUser: false },
    });
    return true;
  }
  if (command === "playlist" && /^manage(?:\s|$)/i.test(argument)) {
    const name = argument.slice(6).trim().normalize("NFC");
    const target = s.library.playlists.find((item) =>
      message.targetPlaylistId
        ? item.id === message.targetPlaylistId
        : name
          ? item.name.toLowerCase() === name.toLowerCase()
          : item.id === s.library.activeId,
    );
    if (!target) throw new Error("Плейлист не найден. Используйте !music playlists.");
    await send({
      content: `**${escapeMarkdown(target.name)}** · ${target.tracks.length}/100 треков`,
      components: [
        new ActionRowBuilder<ButtonBuilder>().addComponents(
          new ButtonBuilder()
            .setCustomId(`music:library-add:${target.id}`)
            .setLabel("Добавить треки")
            .setStyle(ButtonStyle.Success),
          new ButtonBuilder()
            .setCustomId(`music:library-rename:${target.id}`)
            .setLabel("Переименовать")
            .setStyle(ButtonStyle.Secondary),
          new ButtonBuilder()
            .setCustomId(`music:library-delete:${target.id}`)
            .setLabel("Удалить")
            .setStyle(ButtonStyle.Danger)
            .setDisabled(s.library.playlists.length === 1),
          new ButtonBuilder()
            .setCustomId(`music:library-export:${target.id}`)
            .setLabel("Экспорт")
            .setStyle(ButtonStyle.Secondary),
          new ButtonBuilder()
            .setCustomId(`music:library-search:${target.id}`)
            .setLabel("Поиск")
            .setStyle(ButtonStyle.Primary),
        ),
        new ActionRowBuilder<ButtonBuilder>().addComponents(
          new ButtonBuilder()
            .setCustomId(`music:library-activate:${target.id}`)
            .setLabel("Сделать активным")
            .setStyle(ButtonStyle.Success)
            .setDisabled(target.id === s.library.activeId),
        ),
      ],
      allowedMentions: { parse: [], repliedUser: false },
    });
    return true;
  }
  if (command === "playlist" && /^export(?:\s|$)/i.test(argument)) {
    if (message.expectedPlaylistId && message.expectedPlaylistId !== s.library.activeId)
      throw new Error("Плейлист изменился. Откройте его заново.");
    const name = argument.slice(6).trim().normalize("NFC");
    const target = s.library.playlists.find((item) =>
      message.targetPlaylistId
        ? item.id === message.targetPlaylistId
        : name
          ? item.name.toLowerCase() === name.toLowerCase()
          : item.id === s.library.activeId,
    );
    if (!target) throw new Error("Плейлист не найден. Используйте !music playlists.");
    await send({
      content: `Плейлист «${escapeMarkdown(target.name)}»: ${target.tracks.length} треков. Для переноса прикрепите этот файл к сообщению \`!music playlist import\` на другом сервере.`,
      files: [
        new AttachmentBuilder(Buffer.from(exportPlaylist(target)), { name: "playlist.json" }),
      ],
      allowedMentions: { parse: [], repliedUser: false },
    });
    return true;
  }
  return false;
}
