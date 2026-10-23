/** @file Serialize guild music commands and dispatch playlist or playback operations. */
import { showMusicLibrary } from "./library-view.ts";
import {
  startQueue,
  startQueueAt,
  replaceUpcomingQueue,
  shuffled,
  type RepeatMode,
} from "../../../core/music/queue.ts";
import { formatMusicTrack } from "../../music/metadata.ts";
import { readMusicLibrary, writeMusicLibrary, type MusicLibrary } from "../../music/library.ts";
import { resolvePath } from "../../../core/paths.ts";
import { musicMessageComponents } from "./messages.ts";
import { parseMusicCommand } from "./commands.ts";
import { musicUrl, youtubePlaylistUrl } from "../../music/url.ts";
import { type PlaylistResult } from "../../music/youtube-playlist.ts";
import { panel } from "./panel.ts";
import { help } from "./help.ts";
import {
  type Message,
  PermissionFlagsBits,
  ActionRowBuilder,
  StringSelectMenuBuilder,
  escapeMarkdown,
} from "discord.js";
import {
  joinVoiceChannel,
  entersState,
  AudioPlayerStatus,
  VoiceConnectionStatus,
} from "@discordjs/voice";
import type { MusicRuntime } from "./runtime.ts";
import type { MusicRequest } from "./request.ts";
import { handlePlaylistCommand } from "./playlist-commands.ts";

/** Create the serialized text-command boundary using the shared guild playback runtime. */
export function createMusicCommandHandler(runtime: MusicRuntime) {
  const {
    states,
    searchChoices,
    playlistMenus,
    listingTasks,
    locks,
    imports,
    sendTrackList,
    panels,
    publish,
    refresh,
    newState,
    cleanup,
    disconnect,
    next,
    requireVoiceChannel,
    directory,
    loadPlaylist,
    search,
  } = runtime;
  /** Recognize music requests and serialize guild actions, enforcing voice-channel access for mutations.
   * @returns Whether the request belongs to the music subsystem. */
  async function handle(message: MusicRequest): Promise<boolean> {
    const parsed = parseMusicCommand(message.content ?? "");
    if (!parsed) return false;
    const send = (payload: Parameters<MusicRequest["reply"]>[0]) =>
      message.reply({ ...payload, components: musicMessageComponents(payload.components) });
    const reply = async (content: string) => {
      await send({ content, allowedMentions: { parse: [], repliedUser: false } });
    };
    const success = async (content: string) => {
      if (!message.silentSuccess) await reply(content);
    };
    /** Keep expanded bilingual help within Discord's message limit, preserving paragraph boundaries. */
    const showHelp = async () => {
      let page = "";
      for (const paragraph of help.split("\n\n")) {
        if (page && page.length + paragraph.length + 2 > 1900) {
          await reply(page);
          page = "";
        }
        page += `${page ? "\n\n" : ""}${paragraph}`;
      }
      if (page) await reply(page);
    };
    if (!message.guild) {
      await reply("Музыка доступна в голосовых каналах Discord-сервера.");
      return true;
    }
    const guild = message.guild;
    let listingTask: Promise<void> | undefined;
    const previous = locks.get(guild.id) ?? Promise.resolve();
    const task = previous
      .catch(() => {})
      .then(async () => {
        if (runtime.closed) return;
        let { command, argument } = parsed;
        if (command === "help") {
          await showHelp();
          return;
        }
        let s = states.get(guild.id);
        const file = resolvePath(`music_${guild.id}.json`, directory);
        if (!s) {
          s = newState();
          s.guildName = guild.name;
          try {
            s.library = await readMusicLibrary(file, musicUrl);
            s.tracks = s.library.playlists.find((item) => item.id === s.library.activeId)!.tracks;
          } catch {
            throw new Error("Не удалось прочитать сохранённые плейлисты.");
          }
          const state = s;
          const notify = (text: string) => {
            void reply(text).catch(() => {});
          };
          s.player.on(AudioPlayerStatus.Idle, () => {
            if (!state.replacing) next(state, notify);
          });
          s.player.on(AudioPlayerStatus.Playing, () => {
            if (state.timer) clearTimeout(state.timer);
            state.timer = null;
          });
          s.player.on("error", () => {
            state.advanceReason = "failed";
            state.error = "Ошибка аудиоплеера; пропускаю трек.";
            publish();
            notify(state.error);
            if (!state.player.stop(true)) next(state, notify);
          });
          states.set(guild.id, s);
          s.player.on("stateChange", () => refresh(guild.id));
        }
        if (command === "panel") {
          const posted = await send(panel(s));
          if (
            !message.transientPanel &&
            posted &&
            typeof (posted as Message).edit === "function" &&
            (posted as Message).id
          ) {
            const old = panels.get(guild.id);
            panels.set(guild.id, posted as Message);
            if (old && old.id !== (posted as Message).id)
              await old.edit({ components: musicMessageComponents() }).catch(() => {});
          }
          return;
        }
        if (await showMusicLibrary(command, argument, message, s, send)) return;
        if (command === "list" || command === "queue") {
          const snapshot = [...(command === "queue" ? s.pending : s.tracks)];
          const listingName = s.library.playlists.find(
            (item) => item.id === s.library.activeId,
          )!.name;
          let selectionToken: string | undefined;
          if (command === "list" && snapshot.length) {
            for (const [key, menu] of playlistMenus)
              if (menu.expires <= Date.now()) playlistMenus.delete(key);
            while (playlistMenus.size >= 100)
              playlistMenus.delete(playlistMenus.keys().next().value!);
            selectionToken = crypto.randomUUID();
            playlistMenus.set(selectionToken, {
              userId: message.author.id,
              guildId: guild.id,
              playlistId: s.library.activeId,
              tracks: snapshot,
              expires: Date.now() + 300_000,
            });
          }
          // Metadata reads run outside the mutation queue so stop/skip remain responsive.
          listingTask = sendTrackList(
            snapshot,
            s.current,
            command === "queue" ? "Очередь пуста." : "Плейлист пуст.",
            async (content, components) => {
              await send({
                content,
                components,
                allowedMentions: { parse: [], repliedUser: false },
              });
            },
            selectionToken,
            command === "list" ? `**${escapeMarkdown(listingName)}**` : undefined,
          )
            .catch(async () => {
              if (!runtime.closed)
                await reply("Не удалось показать список треков.").catch(() => {});
            })
            .finally(() => listingTasks.delete(listingTask!));
          listingTasks.add(listingTask);
          return;
        }
        const channel = await requireVoiceChannel(guild, message.author.id);
        if (message.expectedPlaylistId && message.expectedPlaylistId !== s.library.activeId)
          throw new Error("Плейлист изменился. Откройте его заново.");
        /** Commit the complete library before exposing a new selected playlist to other commands. */
        const saveLibrary = async (library: MusicLibrary) => {
          await writeMusicLibrary(file, library);
          const switched = s.library.activeId !== library.activeId;
          s.library = library;
          s.tracks = library.playlists.find((item) => item.id === library.activeId)!.tracks;
          if (switched && s.connection) {
            replaceUpcomingQueue(s, s.tracks);
            if (!s.current) next(s, (text) => void reply(text).catch(() => {}));
          }
        };
        let destinationId = message.targetPlaylistId;
        if (command === "playlist" && /^(add|search)(?:\s|$)/i.test(argument)) {
          const operation = argument.split(/\s/, 1)[0].toLowerCase();
          const input = argument.slice(operation.length).trim();
          if (destinationId) argument = input;
          else {
            if (operation === "search")
              throw new Error(
                "Для поиска в другом плейлисте откройте !music playlist manage <название> и нажмите «Поиск».",
              );
            const match = input.match(/^(.+)\s+(https:\/\/\S+)$/);
            if (!match) throw new Error("Используйте !music playlist add <название> <ссылка>.");
            const target = s.library.playlists.find(
              (item) => item.name.toLowerCase() === match[1].trim().normalize("NFC").toLowerCase(),
            );
            if (!target) throw new Error("Плейлист не найден. Используйте !music playlists.");
            destinationId = target.id;
            argument = match[2];
          }
          command = operation;
        }
        if (command === "playlist") {
          await handlePlaylistCommand(runtime, {
            s,
            argument,
            destinationId,
            message,
            guild,
            saveLibrary,
            reply,
            send,
          });
          return;
        }
        if (command === "search") {
          const destination = s.library.playlists.find(
            (item) => item.id === (destinationId ?? s.library.activeId),
          );
          if (!destination) throw new Error("Плейлист не найден. Используйте !music playlists.");
          const results = await search(argument, imports.signal);
          if (runtime.closed) return;
          for (const [key, choice] of searchChoices)
            if (choice.expires <= Date.now()) searchChoices.delete(key);
          while (searchChoices.size >= 100)
            searchChoices.delete(searchChoices.keys().next().value!);
          const token = crypto.randomUUID();
          searchChoices.set(token, {
            userId: message.author.id,
            guildId: guild.id,
            playlistId: destination.id,
            targeted: Boolean(destinationId),
            urls: results.map((item) => musicUrl(item.url)),
            expires: Date.now() + 300_000,
          });
          const select = new StringSelectMenuBuilder()
            .setCustomId(`music:pick:${token}`)
            .setPlaceholder("Выберите трек для добавления")
            .addOptions(
              results.map((item, i) => ({
                label: `${i + 1}. ${item.title}`.slice(0, 100),
                value: String(i),
                description: formatMusicTrack(item.url, {
                  title: item.title,
                  duration: item.duration ?? null,
                  live: false,
                })
                  .split(" · ")
                  .at(-1)!
                  .slice(0, 100),
              })),
            );
          await send({
            content: `**Поиск · ${escapeMarkdown(destination.name)}**`,
            components: [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select)],
            allowedMentions: { parse: [], repliedUser: false },
          });
          return;
        }
        const save = async (tracks: string[], playlistId = s.library.activeId) => {
          await saveLibrary({
            ...s.library,
            playlists: s.library.playlists.map((item) =>
              item.id === playlistId ? { ...item, tracks } : item,
            ),
          });
        };
        if (["toggle", "pause", "resume", "skip"].includes(command) && !s.current)
          throw new Error("Сейчас ничего не играет.");
        if (command === "toggle")
          command =
            s.player.state.status === AudioPlayerStatus.Paused ||
            s.player.state.status === AudioPlayerStatus.AutoPaused
              ? "resume"
              : "pause";
        let added: string[] = [];
        if (command === "play" && s.current) throw new Error("Музыка уже играет.");
        if (command === "add" || (command === "play" && argument)) {
          const destination = s.library.playlists.find(
            (item) => item.id === (destinationId ?? s.library.activeId),
          );
          if (!destination) throw new Error("Плейлист не найден. Используйте !music playlists.");
          let url: string;
          try {
            url = musicUrl(argument);
          } catch {
            throw new Error("Укажите HTTPS-ссылку на трек поддерживаемого сервиса.");
          }
          if (destination.tracks.length >= 100) throw new Error("В плейлисте уже 100 треков.");
          const playlist = youtubePlaylistUrl(url);
          let note = "";
          if (playlist) {
            await reply("Загружаю YouTube-плейлист…");
            s.importing = true;
            s.error = "";
            publish();
            let result: PlaylistResult;
            try {
              result = await loadPlaylist(
                playlist,
                100 - destination.tracks.length,
                imports.signal,
              );
            } finally {
              s.importing = false;
              publish();
            }
            if (runtime.closed) return;
            added = result.tracks;
            if (result.truncated)
              note += " Достигнут лимит 100 треков; импортирована начальная часть плейлиста.";
            if (result.skipped) note += ` Недоступных записей пропущено: ${result.skipped}.`;
          } else added = [url];
          await save([...destination.tracks, ...added], destination.id);
          await reply(
            `Добавлено треков: ${added.length}. В плейлисте «${escapeMarkdown(destination.name)}»: ${destination.tracks.length + added.length}.${note}`,
          );
          if (command === "add") return;
        }
        switch (command) {
          case "repeat": {
            const modes: RepeatMode[] = ["off", "track", "all"];
            const mode =
              argument.toLowerCase() || modes[(modes.indexOf(s.repeat) + 1) % modes.length];
            if (!modes.includes(mode as RepeatMode))
              throw new Error("Используйте !music repeat off, track или all.");
            s.repeat = mode as RepeatMode;
            await success(
              `🔁 Повтор: ${{ off: "выключен", track: "одного трека", all: "всей очереди" }[s.repeat]}.`,
            );
            break;
          }
          case "shuffle": {
            const value = argument.toLowerCase();
            if (value && !["on", "off"].includes(value))
              throw new Error("Используйте !music shuffle on или off.");
            s.shuffle = value ? value === "on" : !s.shuffle;
            if (s.shuffle) s.pending = shuffled(s.pending);
            await success(`🔀 Случайный порядок ${s.shuffle ? "включён" : "выключен"}.`);
            break;
          }
          case "mix": {
            if (s.pending.length < 2)
              throw new Error("Для перемешивания нужны хотя бы два следующих трека.");
            s.pending = shuffled(s.pending);
            await success("🔀 Очередь перемешана.");
            break;
          }
          case "remove": {
            if (
              message.expectedTracks &&
              (message.expectedTracks.length !== s.tracks.length ||
                message.expectedTracks.some((url, i) => url !== s.tracks[i]))
            )
              throw new Error("Плейлист изменился. Откройте удаление заново.");
            const index = Number(argument);
            if (!/^\d+$/.test(argument) || index < 1 || index > s.tracks.length)
              throw new Error("Укажите номер трека из !music list.");
            await save(s.tracks.filter((_, i) => i !== index - 1));
            await success("Трек удалён из плейлиста.");
            break;
          }
          case "jump":
          case "play": {
            const position = Number(argument) - 1;
            if (command === "jump") {
              if (
                message.expectedTracks &&
                (message.expectedTracks.length !== s.tracks.length ||
                  message.expectedTracks.some((url, i) => url !== s.tracks[i]))
              )
                throw new Error("Плейлист изменился. Откройте его заново.");
              if (
                !/^\d+$/.test(argument) ||
                !Number.isInteger(position) ||
                position < 0 ||
                position >= s.tracks.length
              )
                throw new Error("Укажите номер трека из !music list.");
            }
            if (command === "play" && s.current) throw new Error("Музыка уже играет.");
            if (!s.tracks.length)
              throw new Error("Плейлист пуст. Добавьте трек: !music add <ссылка>.");
            if (!Bun.which("yt-dlp") || !Bun.which("ffmpeg"))
              throw new Error("Для музыки установите на сервере yt-dlp и FFmpeg.");
            const me = await guild.members.fetchMe();
            if (
              !channel
                .permissionsFor(me)
                ?.has([PermissionFlagsBits.Connect, PermissionFlagsBits.Speak])
            )
              throw new Error("Боту нужны права Connect и Speak в этом канале.");
            s.channelName = channel.name;
            s.error = "";
            if (!s.connection) {
              s.connection = joinVoiceChannel({
                channelId: channel.id,
                guildId: guild.id,
                adapterCreator: guild.voiceAdapterCreator,
                selfDeaf: true,
              });
              const state = s;
              s.connection.on(VoiceConnectionStatus.Disconnected, () => disconnect(state));
              s.connection.on("error", () => {
                state.error = "Ошибка голосового подключения.";
                disconnect(state);
              });
              s.connection.on("stateChange", () => publish());
              publish();
            }
            try {
              await entersState(s.connection, VoiceConnectionStatus.Ready, 20_000);
            } catch {
              s.error = "Не удалось подключиться к голосовому каналу.";
              disconnect(s);
              throw new Error(s.error);
            }
            if (runtime.closed) {
              disconnect(s);
              return;
            }
            s.connection.subscribe(s.player);
            if (command === "jump") {
              s.replacing = true;
              try {
                cleanup(s);
                s.player.stop(true);
              } finally {
                s.replacing = false;
              }
              startQueueAt(s, s.tracks, position);
            } else startQueue(s, argument ? added : s.tracks);
            s.advanceReason = "finished";
            next(s, (text) => {
              void reply(text).catch(() => {});
            });
            await success("▶ Включаю музыку.");
            break;
          }
          case "pause":
            s.player.pause();
            await success("⏸ Пауза.");
            break;
          case "resume":
            s.player.unpause();
            await success("▶ Продолжаю.");
            break;
          case "skip":
            s.advanceReason = "skip";
            cleanup(s);
            s.player.stop(true);
            await success("⏭ Следующий трек.");
            break;
          case "stop":
          case "leave":
            disconnect(s);
            await success("⏹ Музыка остановлена, вышел из канала. Плейлист сохранён.");
            break;
          default:
            await showHelp();
        }
      })
      .catch(async (error) => {
        const state = states.get(guild.id);
        if (state)
          state.error = error instanceof Error ? error.message : "Ошибка музыкальной команды.";
        await reply(error instanceof Error ? error.message : "Ошибка музыкальной команды.").catch(
          () => {},
        );
      });
    locks.set(guild.id, task);
    try {
      await task;
    } finally {
      refresh(guild.id);
      if (locks.get(guild.id) === task) locks.delete(guild.id);
    }
    await listingTask;
    return true;
  }
  return handle;
}
