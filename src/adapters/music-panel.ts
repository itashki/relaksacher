/** @file Render Discord music controls from a read-only playback snapshot. */
import { ActionRowBuilder, ButtonBuilder, ButtonStyle, escapeMarkdown } from "discord.js";
import { AudioPlayerStatus, type AudioPlayer } from "@discordjs/voice";
import { formatMusicTrack, type MusicMetadata } from "./music-metadata.ts";
import type { MusicLibrary } from "./music-library.ts";
import type { RepeatMode } from "../core/music-queue.ts";

/** Fields required to render playback controls without owning playback lifecycle. */
type MusicPanelState = {
  player: AudioPlayer;
  current: string;
  metadata: MusicMetadata | null;
  metadataAbort: AbortController | null;
  library: MusicLibrary;
  tracks: string[];
  pending: string[];
  repeat: RepeatMode;
  shuffle: boolean;
  connection: unknown;
};

/** Render current playback controls; disable actions that cannot apply to the current state. */
export function panel(s: MusicPanelState) {
  const paused =
    s.player.state.status === AudioPlayerStatus.Paused ||
    s.player.state.status === AudioPlayerStatus.AutoPaused;
  const active = Boolean(s.current);
  const button = (
    action: string,
    label: string | { emoji: string },
    style = ButtonStyle.Secondary,
    disabled = false,
  ) => {
    const control = new ButtonBuilder()
      .setCustomId(`music:${action}`)
      .setStyle(style)
      .setDisabled(disabled);
    return typeof label === "string" ? control.setLabel(label) : control.setEmoji(label.emoji);
  };
  return {
    content:
      `🎵 **Музыкальный плеер**\n${active ? `${paused ? "⏸ На паузе" : "▶ Сейчас"}: ${formatMusicTrack(s.current, s.metadata, Boolean(s.metadataAbort))}` : "⏹ Воспроизведение остановлено"}\n` +
      `Плейлист: **${escapeMarkdown(s.library.playlists.find((item) => item.id === s.library.activeId)!.name)}**\n` +
      `Сохранено: **${s.tracks.length}/100** · Далее в очереди: **${s.pending.length}**\n` +
      `Повтор: **${{ off: "выкл", track: "трек", all: "вся очередь" }[s.repeat]}** · Случайный порядок: **${s.shuffle ? "вкл" : "выкл"}**`,
    components: [
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        button("play", { emoji: "▶️" }, ButtonStyle.Success, active || !s.tracks.length),
        button("toggle", { emoji: paused ? "▶️" : "⏸️" }, ButtonStyle.Primary, !active),
        button("skip", { emoji: "⏭️" }, ButtonStyle.Secondary, !active),
        button("stop", { emoji: "⏹️" }, ButtonStyle.Danger, !s.connection),
      ),
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        button("add", "＋"),
        button("remove", "−", ButtonStyle.Secondary, !s.tracks.length),
        button("list", "☷"),
        button("search", { emoji: "🔎" }),
        button("playlists", "Плейлисты"),
      ),
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        button(
          "repeat",
          `🔁 Повтор: ${{ off: "выкл", track: "трек", all: "всё" }[s.repeat]}`,
          s.repeat === "off" ? ButtonStyle.Secondary : ButtonStyle.Primary,
        ),
        button(
          "shuffle",
          `🔀 Случайно: ${s.shuffle ? "вкл" : "выкл"}`,
          s.shuffle ? ButtonStyle.Primary : ButtonStyle.Secondary,
        ),
        button("mix", "Перемешать", ButtonStyle.Secondary, s.pending.length < 2),
        button("queue", "Очередь"),
      ),
    ],
    allowedMentions: { parse: [] as never[], repliedUser: false },
  };
}
