/** @file Coordinate per-guild music commands, interactions, persistent playlists and voice playback. */
import {
  createPlaybackQueue,
  startQueue,
  startQueueAt,
  advanceQueue,
  shuffled,
  type AdvanceReason,
  type RepeatMode,
} from "../core/music-queue.ts";
import type { MusicStatus } from "../core/music-status.ts";
import { loadMusicMetadata, formatMusicTrack, type MusicMetadata } from "./music-metadata.ts";
import {
  createMusicLibrary,
  readMusicLibrary,
  writeMusicLibrary,
  playlistName,
  type MusicLibrary,
} from "./music-library.ts";
import { resolvePath } from "../core/paths.ts";
import { musicMessageComponents } from "./music-messages.ts";
import { parseMusicCommand } from "./music-commands.ts";
import { musicUrl, youtubePlaylistUrl } from "./music-url.ts";
import { loadYouTubePlaylist, type PlaylistResult } from "./music-youtube-playlist.ts";
import { searchMusic } from "./music-search.ts";
import { createMusicTrackList } from "./music-track-list.ts";
import { panel } from "./music-panel.ts";
import { help } from "./music-help.ts";
import { createMusicPipeline } from "./music-process.ts";
import { exportPlaylist, parsePlaylist, downloadPlaylist } from "./music-transfer.ts";
import {
  type Message,
  type Interaction,
  type Guild,
  type User,
  PermissionFlagsBits,
  ChannelType,
  ActionRowBuilder,
  ButtonBuilder,
  StringSelectMenuBuilder,
  ButtonStyle,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  MessageFlags,
  escapeMarkdown,
  AttachmentBuilder,
} from "discord.js";
import {
  createAudioPlayer,
  createAudioResource,
  joinVoiceChannel,
  entersState,
  AudioPlayerStatus,
  VoiceConnectionStatus,
  StreamType,
  type VoiceConnection,
} from "@discordjs/voice";

export { musicUrl, youtubePlaylistUrl } from "./music-url.ts";
export { loadYouTubePlaylist } from "./music-youtube-playlist.ts";
export { searchMusic, type MusicSearchResult } from "./music-search.ts";

type MusicRequest = {
  /** Render private player controls without replacing the shared guild panel. */
  transientPanel?: boolean;
  /** Bind an edit to a saved playlist ID independently of the server's active selection. */
  targetPlaylistId?: string;
  attachments?: { values(): IterableIterator<{ url: string; size: number }> };
  expectedPlaylistId?: string;
  expectedTracks?: string[];
  content: string;
  guild: Guild | null;
  author: Pick<User, "id">;
  reply: (payload: {
    content: string;
    files?: AttachmentBuilder[];
    components?: (ActionRowBuilder<ButtonBuilder> | ActionRowBuilder<StringSelectMenuBuilder>)[];
    allowedMentions: { parse: never[]; repliedUser: boolean };
  }) => Promise<unknown>;
};

/** Persistent guild playlists, independent of model generation. */
export function createDiscordMusic(
  directory: string,
  {
    loadPlaylist = loadYouTubePlaylist,
    search = searchMusic,
    loadMetadata = loadMusicMetadata,
    onStatus = () => {},
    downloadPlaylistFile = downloadPlaylist,
  }: {
    search?: typeof searchMusic;
    loadMetadata?: typeof loadMusicMetadata;
    onStatus?: (statuses: MusicStatus[]) => void;
    loadPlaylist?: (url: string, limit: number, signal: AbortSignal) => Promise<PlaylistResult>;
    downloadPlaylistFile?: typeof downloadPlaylist;
  } = {},
) {
  const states = new Map<string, ReturnType<typeof newState>>();
  const searchChoices = new Map<
    string,
    {
      userId: string;
      guildId: string;
      playlistId: string;
      targeted: boolean;
      urls: string[];
      expires: number;
    }
  >();
  const playlistMenus = new Map<
    string,
    { userId: string; guildId: string; playlistId: string; tracks: string[]; expires: number }
  >();
  const removalMenus = new Map<
    string,
    { userId: string; guildId: string; playlistId: string; tracks: string[]; expires: number }
  >();
  const playlistDeletions = new Map<
    string,
    {
      userId: string;
      guildId: string;
      playlistId: string;
      snapshot: string;
      expires: number;
    }
  >();
  const metadataTasks = new Set<Promise<void>>();
  const listingTasks = new Set<Promise<void>>();
  const locks = new Map<string, Promise<unknown>>();
  let closed = false;
  let shutdownTask: Promise<void> | undefined;
  const imports = new AbortController();
  const { trackMetadata, listingMetadata, sendTrackList } = createMusicTrackList(
    loadMetadata,
    imports.signal,
    () => closed,
  );
  const panels = new Map<string, Message>();
  const refreshTimers = new Map<string, ReturnType<typeof setTimeout>>();
  /** Emit detached scalar snapshots for every initialized guild, including playback modes and errors. */
  function publish() {
    onStatus(
      [...states.entries()].map(([guildId, s]): MusicStatus => ({
        guildId,
        guildName: s.guildName || guildId,
        channelId: s.connection?.joinConfig.channelId ?? null,
        channelName: s.connection ? s.channelName : null,
        status: s.importing
          ? "importing"
          : !s.connection
            ? "stopped"
            : s.connection.state.status !== VoiceConnectionStatus.Ready
              ? "connecting"
              : !s.current
                ? "idle"
                : s.player.state.status === AudioPlayerStatus.Paused ||
                    s.player.state.status === AudioPlayerStatus.AutoPaused
                  ? "paused"
                  : s.player.state.status === AudioPlayerStatus.Playing
                    ? "playing"
                    : "buffering",
        current: s.current,
        saved: s.tracks.length,
        queued: s.pending.length,
        error: s.error,
        repeat: s.repeat,
        shuffle: s.shuffle,
      })),
    );
  }
  /** Publish local telemetry immediately and coalesce edits to the latest Discord panel. */
  function refresh(guildId: string) {
    publish();
    if (closed || refreshTimers.has(guildId) || !panels.has(guildId)) return;
    refreshTimers.set(
      guildId,
      setTimeout(() => {
        refreshTimers.delete(guildId);
        const message = panels.get(guildId),
          state = states.get(guildId);
        if (message && state) {
          const payload = panel(state);
          void message
            .edit({ ...payload, components: musicMessageComponents(payload.components) })
            .catch(() => {
              if (panels.get(guildId) === message) panels.delete(guildId);
            });
        }
      }, 300),
    );
  }
  /** Refresh the panel owning a player after an asynchronous metadata update. */
  function refreshGuild(state: State) {
    for (const [guildId, candidate] of states)
      if (candidate === state) {
        refresh(guildId);
        break;
      }
  }
  /** Create independent player and queue state for a guild; no voice connection is opened yet. */
  function newState() {
    const player = createAudioPlayer();
    return {
      ...createPlaybackQueue(),
      advanceReason: "finished" as AdvanceReason,
      guildName: "",
      channelName: "",
      importing: false,
      replacing: false,
      metadata: null as MusicMetadata | null,
      metadataAbort: null as AbortController | null,
      error: "",
      player,
      tracks: [] as string[],
      library: createMusicLibrary(),
      connection: null as VoiceConnection | null,
      playback: null as ReturnType<typeof createMusicPipeline> | null,
      timer: null as ReturnType<typeof setTimeout> | null,
    };
  }
  type State = ReturnType<typeof newState>;
  /** Clear the playback deadline and stop the active source/encoder pipeline without advancing the queue. */
  function cleanup(s: State) {
    s.metadataAbort?.abort();
    s.metadataAbort = null;
    s.metadata = null;
    if (s.timer) clearTimeout(s.timer);
    s.timer = null;
    const playback = s.playback;
    s.playback = null;
    playback?.stop();
  }
  /** Clear the playback selection and close voice transport while retaining saved tracks and modes. */
  function disconnect(s: State) {
    s.pending = [];
    s.current = "";
    s.cycle = [];
    s.failedTracks.clear();
    s.advanceReason = "finished";
    const connection = s.connection;
    s.connection = null;
    cleanup(s);
    s.player.stop(true);
    if (connection && connection.state.status !== VoiceConnectionStatus.Destroyed)
      connection.destroy();
    publish();
  }
  /** Advance according to completion/skip/failure semantics and start one bounded audio pipeline. */
  function next(s: State, notify: (text: string) => void) {
    cleanup(s);
    if (closed || !s.connection) return;
    advanceQueue(s, s.advanceReason);
    s.advanceReason = "finished";
    if (!s.current) {
      publish();
      s.timer = setTimeout(() => disconnect(s), 60_000);
      return;
    }
    // Resolve display data independently; a stale lookup must never overwrite a new track.
    const metadataAbort = new AbortController();
    s.metadataAbort = metadataAbort;
    const currentUrl = s.current;
    const task = Promise.resolve()
      .then(() => trackMetadata(currentUrl, metadataAbort.signal))
      .then((metadata) => {
        if (!closed && s.metadataAbort === metadataAbort) s.metadata = metadata;
      })
      .catch(() => {}) // Metadata failure does not interrupt audio playback.
      .finally(() => {
        metadataTasks.delete(task);
        if (!closed && s.metadataAbort === metadataAbort) {
          s.metadataAbort = null;
          refreshGuild(s);
        }
      });
    metadataTasks.add(task);
    refreshGuild(s);
    // No shell interpolation. yt-dlp resolves expiring media URLs at playback time.
    let playback: ReturnType<typeof createMusicPipeline> | null = null;
    let failed = false;
    const fail = () => {
      if (failed || (playback && s.playback !== playback)) return;
      failed = true;
      s.advanceReason = "failed";
      s.error =
        "Не удалось проиграть трек: источник недоступен или произошла ошибка yt-dlp/FFmpeg. Пропускаю трек.";
      publish();
      notify(s.error);
      cleanup(s);
      const stopped = s.player.stop(true);
      if (!stopped) next(s, notify);
    };
    try {
      playback = createMusicPipeline(
        [
          "yt-dlp",
          "--ignore-config",
          "--no-playlist",
          "--no-progress",
          "--socket-timeout",
          "15",
          "-f",
          "bestaudio/best",
          "-o",
          "-",
          "--",
          s.current,
        ],
        [
          "ffmpeg",
          "-hide_banner",
          "-loglevel",
          "error",
          "-i",
          "pipe:0",
          "-f",
          "s16le",
          "-ar",
          "48000",
          "-ac",
          "2",
          "pipe:1",
        ],
        fail,
      );
      s.playback = playback;
      s.timer = setTimeout(fail, 45_000);
      s.player.play(createAudioResource(playback.stream, { inputType: StreamType.Raw }));
    } catch {
      fail();
    }
  }
  /** Require a regular voice channel and, when connected, the bot's channel. */
  async function requireVoiceChannel(guild: Guild, userId: string) {
    const member = await guild.members.fetch(userId);
    const channel = member.voice.channel;
    if (!channel || channel.type !== ChannelType.GuildVoice)
      throw new Error("Сначала войдите в обычный голосовой канал.");
    const connection = states.get(guild.id)?.connection;
    if (connection && connection.joinConfig.channelId !== channel.id)
      throw new Error("Для управления войдите в голосовой канал бота.");
    return channel;
  }
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
        if (closed) return;
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
          return;
        }
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
              if (!closed) await reply("Не удалось показать список треков.").catch(() => {});
            })
            .finally(() => listingTasks.delete(listingTask!));
          listingTasks.add(listingTask);
          return;
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
          return;
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
          return;
        }
        const channel = await requireVoiceChannel(guild, message.author.id);
        if (message.expectedPlaylistId && message.expectedPlaylistId !== s.library.activeId)
          throw new Error("Плейлист изменился. Откройте его заново.");
        /** Commit the complete library before exposing a new selected playlist to other commands. */
        const saveLibrary = async (library: MusicLibrary) => {
          await writeMusicLibrary(file, library);
          s.library = library;
          s.tracks = library.playlists.find((item) => item.id === library.activeId)!.tracks;
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
            if (closed) return;
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
            await reply(
              `Импортирован плейлист **${escapeMarkdown(name)}**: ${item.tracks.length} треков.`,
            );
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
            if (library.playlists.length === 1)
              throw new Error("Нельзя удалить последний плейлист.");
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
            const names =
              action === "rename" && !destinationId ? rawName.split(/\s+\|\s+/) : [rawName];
            if (names.length > 2)
              throw new Error("Используйте !music playlist rename <название> | <новое название>.");
            const target = destinationId
              ? library.playlists.find((item) => item.id === destinationId)
              : names.length === 2
                ? library.playlists.find(
                    (item) =>
                      item.name.toLowerCase() === names[0].trim().normalize("NFC").toLowerCase(),
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
            if (!rawName || !target)
              throw new Error("Плейлист не найден. Используйте !music playlists.");
            await saveLibrary({ ...library, activeId: target.id });
            await reply(`Активный плейлист: **${escapeMarkdown(target.name)}**.`);
            return;
          }
          if (action === "delete") {
            if (!target) throw new Error("Плейлист не найден.");
            if (library.playlists.length === 1)
              throw new Error("Нельзя удалить последний плейлист.");
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
        if (command === "search") {
          const destination = s.library.playlists.find(
            (item) => item.id === (destinationId ?? s.library.activeId),
          );
          if (!destination) throw new Error("Плейлист не найден. Используйте !music playlists.");
          const results = await search(argument, imports.signal);
          if (closed) return;
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
            if (closed) return;
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
            await reply(
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
            await reply(`🔀 Случайный порядок ${s.shuffle ? "включён" : "выключен"}.`);
            break;
          }
          case "mix": {
            if (s.pending.length < 2)
              throw new Error("Для перемешивания нужны хотя бы два следующих трека.");
            s.pending = shuffled(s.pending);
            await reply("🔀 Очередь перемешана.");
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
            await reply("Трек удалён из плейлиста.");
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
            if (closed) {
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
            await reply("▶ Включаю музыку.");
            break;
          }
          case "pause":
            s.player.pause();
            await reply("⏸ Пауза.");
            break;
          case "resume":
            s.player.unpause();
            await reply("▶ Продолжаю.");
            break;
          case "skip":
            s.advanceReason = "skip";
            cleanup(s);
            s.player.stop(true);
            await reply("⏭ Следующий трек.");
            break;
          case "stop":
          case "leave":
            disconnect(s);
            await reply("⏹ Музыка остановлена, вышел из канала. Плейлист сохранён.");
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
  /** Check voice access before opening forms; route submissions through the shared command handler. */
  async function handleInteraction(interaction: Interaction): Promise<boolean> {
    if (
      (!interaction.isButton() &&
        !interaction.isModalSubmit() &&
        !interaction.isStringSelectMenu?.()) ||
      !interaction.customId.startsWith("music:")
    )
      return false;
    type ResponsePayload = Omit<Parameters<MusicRequest["reply"]>[0], "allowedMentions"> & {
      allowedMentions?: { parse: never[]; repliedUser: boolean };
      flags?: MessageFlags.Ephemeral;
    };
    const privateSource = Boolean(interaction.message?.flags?.has(MessageFlags.Ephemeral));
    let backAction: string | undefined = "music:back:panel";
    const controls = (payload: ResponsePayload) =>
      musicMessageComponents(payload.components, backAction);
    // A private screen is replaced in place, so button navigation cannot leave an old personal message behind.
    const deferResponse = () =>
      privateSource
        ? interaction.deferUpdate()
        : interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const respond = async (payload: ResponsePayload) => {
      if (privateSource) {
        await interaction.deferUpdate();
        return interaction.editReply({
          content: payload.content,
          files: payload.files,
          attachments: [],
          allowedMentions: payload.allowedMentions,
          components: controls(payload),
        });
      }
      return interaction.reply({ ...payload, components: controls(payload) });
    };
    const editResponse = (payload: Omit<ResponsePayload, "flags">) =>
      interaction.editReply({ ...payload, attachments: [], components: controls(payload) });
    const followUp = (payload: ResponsePayload) =>
      interaction.followUp({ ...payload, components: controls(payload) });
    try {
      if (interaction.isButton() && interaction.customId === "music:dismiss") {
        await interaction.deferUpdate();
        await interaction.deleteReply();
        const guildId = interaction.guild?.id;
        if (guildId && panels.get(guildId)?.id === interaction.message.id) {
          panels.delete(guildId);
          const timer = refreshTimers.get(guildId);
          if (timer) clearTimeout(timer);
          refreshTimers.delete(guildId);
        }
        return true;
      }
      if (!interaction.guild) {
        await respond({
          content: "Музыка доступна только на сервере.",
          flags: MessageFlags.Ephemeral,
        });
        return true;
      }
      if (
        interaction.isButton() &&
        !privateSource &&
        !interaction.customId.startsWith("music:back:") &&
        !interaction.customId.startsWith("music:pick:") &&
        !interaction.customId.startsWith("music:delete:") &&
        !interaction.customId.startsWith("music:playlist-") &&
        !interaction.customId.startsWith("music:library") &&
        !panels.has(interaction.guild.id) &&
        interaction.message?.id
      ) {
        panels.set(interaction.guild.id, interaction.message);
      }
      let action = interaction.customId.slice("music:".length);
      if (interaction.isButton() && action.startsWith("back:")) {
        const [, view, id] = action.split(":");
        if (
          !["panel", "playlists", "manage"].includes(view) ||
          (view === "manage" && (!id || !/^[\w-]{1,64}$/.test(id)))
        )
          throw new Error("Invalid navigation");
        backAction =
          view === "panel"
            ? undefined
            : view === "manage"
              ? "music:back:playlists"
              : "music:back:panel";
        await deferResponse();
        await handle({
          content:
            view === "panel"
              ? "!music panel"
              : view === "playlists"
                ? "!music playlists"
                : "!music playlist manage",
          targetPlaylistId: view === "manage" ? id : undefined,
          transientPanel: true,
          guild: interaction.guild,
          author: interaction.user,
          reply: async (payload) => {
            await editResponse(payload);
          },
        });
        return true;
      }

      if (action === "library" || action.startsWith("library-") || action.startsWith("playlist-")) {
        const [kind, token] = action.split(":");
        const operation = kind.startsWith("library-") ? kind.slice(8) : kind.slice(9);
        backAction =
          token && kind.startsWith("library-")
            ? `music:back:manage:${token}`
            : "music:back:playlists";
        if (interaction.isButton() && ["create", "rename", "add", "search"].includes(operation)) {
          try {
            await requireVoiceChannel(interaction.guild, interaction.user.id);
          } catch (error) {
            await respond({
              content:
                error instanceof Error ? error.message : "Не удалось проверить голосовой канал.",
              flags: MessageFlags.Ephemeral,
            });
            return true;
          }
          const input = new TextInputBuilder()
            .setCustomId("value")
            .setLabel(
              operation === "search"
                ? "Запрос (yt:, sc:, bc:, am:, ym:)"
                : operation === "add"
                  ? "Ссылка на трек или YouTube-плейлист"
                  : "Название плейлиста",
            )
            .setStyle(TextInputStyle.Short)
            .setRequired(true)
            .setMaxLength(operation === "search" ? 200 : operation === "add" ? 500 : 60);
          await interaction.showModal(
            new ModalBuilder()
              .setCustomId(`music:${action}`)
              .setTitle(
                operation === "create"
                  ? "Создать плейлист"
                  : operation === "rename"
                    ? "Переименовать плейлист"
                    : operation === "search"
                      ? "Поиск музыки"
                      : "Добавить треки",
              )
              .addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(input)),
          );
          return true;
        }
        let argument: string;
        if (["library", "library-manage"].includes(action) && interaction.isStringSelectMenu()) {
          const id = interaction.values[0] ?? "";
          if (!/^[\w-]{1,64}$/.test(id)) throw new Error("Invalid playlist selection");
          await deferResponse();
          backAction = "music:back:playlists";
          await handle({
            content: "!music playlist manage",
            targetPlaylistId: id,
            guild: interaction.guild,
            author: interaction.user,
            reply: async (payload) => {
              await editResponse(payload);
            },
          });
          return true;
        } else if (
          interaction.isModalSubmit() &&
          ["create", "rename", "delete", "add", "search"].includes(operation)
        ) {
          argument = `${operation} ${interaction.fields.getTextInputValue("value").trim()}`;
        } else if (interaction.isButton() && ["confirm", "cancel"].includes(operation) && token) {
          argument = `${operation} ${token}`;
        } else if (interaction.isButton() && operation === "activate" && token) {
          argument = `select ${token}`;
        } else if (interaction.isButton() && operation === "export") {
          argument = "export";
        } else if (interaction.isButton() && operation === "delete") {
          argument = "delete";
        } else throw new Error("Invalid playlist action");
        await deferResponse();
        await handle({
          content: `!music playlist ${argument}`,
          guild: interaction.guild,
          author: interaction.user,
          targetPlaylistId:
            kind.startsWith("library-") && operation !== "create" ? token : undefined,
          reply: async (payload) => {
            await editResponse(payload);
          },
        });
        return true;
      }
      if (interaction.isStringSelectMenu?.() && action.startsWith("jump:")) {
        const [, token, offsetText] = action.split(":");
        const menu = playlistMenus.get(token ?? "");
        const value = interaction.values[0] ?? "";
        const index = Number(value),
          offset = Number(offsetText);
        if (
          !menu ||
          menu.userId !== interaction.user.id ||
          menu.guildId !== interaction.guild.id ||
          menu.expires <= Date.now()
        ) {
          await respond({
            content: "Этот плейлист недоступен. Откройте свой плейлист заново.",
            flags: MessageFlags.Ephemeral,
          });
          return true;
        }
        if (
          !/^\d+$/.test(value) ||
          !Number.isInteger(offset) ||
          offset < 0 ||
          offset % 25 !== 0 ||
          index < offset ||
          index >= Math.min(offset + 25, menu.tracks.length)
        ) {
          await respond({
            content: "Некорректный выбор трека.",
            flags: MessageFlags.Ephemeral,
          });
          return true;
        }
        await deferResponse();
        await handle({
          content: `!music jump ${index + 1}`,
          guild: interaction.guild,
          author: interaction.user,
          expectedTracks: menu.tracks,
          expectedPlaylistId: menu.playlistId,
          reply: async (payload) => {
            await editResponse(payload);
          },
        });
        return true;
      }
      if ((interaction.isButton() && action === "remove") || action.startsWith("delete:")) {
        try {
          await requireVoiceChannel(interaction.guild, interaction.user.id);
        } catch (error) {
          await respond({
            content:
              error instanceof Error ? error.message : "Не удалось проверить голосовой канал.",
            flags: MessageFlags.Ephemeral,
          });
          return true;
        }
        const [, token, pageText = "0"] = action.split(":");
        let menu = token ? removalMenus.get(token) : undefined;
        if (
          token &&
          (!menu ||
            menu.userId !== interaction.user.id ||
            menu.guildId !== interaction.guild.id ||
            menu.expires <= Date.now())
        ) {
          await respond({
            content: "Список удаления недоступен. Откройте его заново.",
            flags: MessageFlags.Ephemeral,
          });
          return true;
        }
        if (token && (interaction.isButton() || interaction.isStringSelectMenu()))
          await interaction.deferUpdate();
        else await deferResponse();
        if (!states.has(interaction.guild.id))
          await handle({
            content: "!music list",
            guild: interaction.guild,
            author: interaction.user,
            reply: async () => {},
          });
        const tracks = states.get(interaction.guild.id)?.tracks ?? [];
        if (!menu) {
          menu = {
            userId: interaction.user.id,
            guildId: interaction.guild.id,
            playlistId: states.get(interaction.guild.id)!.library.activeId,
            tracks: [...tracks],
            expires: Date.now() + 300_000,
          };
        }
        if (
          menu.playlistId !== states.get(interaction.guild.id)!.library.activeId ||
          menu.tracks.length !== tracks.length ||
          menu.tracks.some((url, i) => url !== tracks[i])
        ) {
          await editResponse({ content: "Плейлист изменился. Откройте удаление заново." });
          return true;
        }
        if (interaction.isStringSelectMenu?.()) {
          const value = interaction.values[0] ?? "";
          const index = Number(value);
          const page = Number(pageText);
          if (
            !/^\d+$/.test(value) ||
            !Number.isInteger(page) ||
            index < page * 25 ||
            index >= Math.min(menu.tracks.length, (page + 1) * 25)
          ) {
            await editResponse({ content: "Некорректный выбор трека." });
            return true;
          }
          await handle({
            content: `!music remove ${index + 1}`,
            guild: interaction.guild,
            author: interaction.user,
            expectedTracks: menu.tracks,
            expectedPlaylistId: menu.playlistId,
            reply: async (payload) => {
              await editResponse(payload);
            },
          });
          return true;
        }
        if (!tracks.length) {
          await editResponse({ content: "Плейлист пуст." });
          return true;
        }
        const page = Number(pageText);
        if (!Number.isInteger(page) || page < 0 || page * 25 >= menu.tracks.length) {
          await editResponse({ content: "Такой страницы нет." });
          return true;
        }
        for (const [key, value] of removalMenus)
          if (value.expires <= Date.now()) removalMenus.delete(key);
        while (removalMenus.size >= 100) removalMenus.delete(removalMenus.keys().next().value!);
        const menuToken = token ?? crypto.randomUUID();
        removalMenus.set(menuToken, menu);
        const slice = menu.tracks.slice(page * 25, (page + 1) * 25);
        const metadata = new Map<string, MusicMetadata | null>();
        let cursor = 0;
        await Promise.all(
          Array.from({ length: Math.min(3, slice.length) }, async () => {
            while (cursor < slice.length) {
              const url = slice[cursor++];
              metadata.set(url, await listingMetadata(url));
            }
          }),
        );
        const select = new StringSelectMenuBuilder()
          .setCustomId(`music:delete:${menuToken}:${page}`)
          .setPlaceholder("Выберите трек для удаления")
          .addOptions(
            slice.map((url, i) => {
              const info = metadata.get(url);
              return {
                label: `${page * 25 + i + 1}. ${info?.title ?? url}`.slice(0, 100),
                value: String(page * 25 + i),
                description: formatMusicTrack(url, info ?? null)
                  .split(" · ")
                  .at(-1)!
                  .slice(0, 100),
              };
            }),
          );
        await editResponse({
          content: `Удаление треков · страница ${page + 1}/${Math.ceil(menu.tracks.length / 25)}`,
          components: [
            new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select),
            new ActionRowBuilder<ButtonBuilder>().addComponents(
              new ButtonBuilder()
                .setCustomId(`music:delete:${menuToken}:${page - 1}`)
                .setLabel("←")
                .setStyle(ButtonStyle.Secondary)
                .setDisabled(page === 0),
              new ButtonBuilder()
                .setCustomId(`music:delete:${menuToken}:${page + 1}`)
                .setLabel("→")
                .setStyle(ButtonStyle.Secondary)
                .setDisabled((page + 1) * 25 >= menu.tracks.length),
            ),
          ],
        });
        return true;
      }
      let selectedUrl = "";
      let selectedPlaylistId: string | undefined;
      let selectedDestinationId: string | undefined;
      if (interaction.isStringSelectMenu?.() && action.startsWith("pick:")) {
        const choice = searchChoices.get(action.slice(5));
        if (
          !choice ||
          choice.expires <= Date.now() ||
          choice.userId !== interaction.user.id ||
          choice.guildId !== interaction.guild.id
        ) {
          await respond({
            content: "Этот результат недоступен. Выполните свой поиск заново.",
            flags: MessageFlags.Ephemeral,
          });
          return true;
        }
        const value = interaction.values[0] ?? "";
        if (!/^\d+$/.test(value) || !choice.urls[Number(value)]) {
          await respond({
            content: "Некорректный выбор трека.",
            flags: MessageFlags.Ephemeral,
          });
          return true;
        }
        selectedUrl = choice.urls[Number(value)];
        if (choice.targeted) {
          selectedDestinationId = choice.playlistId;
          backAction = `music:back:manage:${choice.playlistId}`;
        } else selectedPlaylistId = choice.playlistId;
        action = "add";
      }
      if (interaction.isButton() && !selectedUrl && ["add", "remove", "search"].includes(action)) {
        try {
          await requireVoiceChannel(interaction.guild, interaction.user.id);
        } catch (error) {
          await respond({
            content:
              error instanceof Error ? error.message : "Не удалось проверить голосовой канал.",
            flags: MessageFlags.Ephemeral,
          });
          return true;
        }
        const input = new TextInputBuilder()
          .setCustomId("value")
          .setLabel(
            action === "search"
              ? "Запрос (yt:, sc:, bc:, am:, ym:)"
              : action === "add"
                ? "Ссылка на трек или YouTube-плейлист"
                : "Номер трека из плейлиста",
          )
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setMaxLength(action === "search" ? 200 : action === "add" ? 500 : 3)
          .setPlaceholder(
            action === "search"
              ? "Исполнитель — название"
              : action === "add"
                ? "https://www.youtube.com/playlist?list=…"
                : "Например: 3",
          );
        await interaction.showModal(
          new ModalBuilder()
            .setCustomId(`music:${action}`)
            .setTitle(
              action === "search"
                ? "Поиск музыки"
                : action === "add"
                  ? "Добавить музыку"
                  : "Удалить трек",
            )
            .addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(input)),
        );
        return true;
      }
      if (
        ![
          "search",
          "play",
          "toggle",
          "skip",
          "stop",
          "list",
          "add",
          "remove",
          "repeat",
          "shuffle",
          "mix",
          "queue",
          "playlists",
        ].includes(action) ||
        (interaction.isModalSubmit() && !["add", "remove", "search"].includes(action))
      ) {
        await respond({
          content: "Неизвестное действие. Откройте !music заново.",
          flags: MessageFlags.Ephemeral,
        });
        return true;
      }
      // Acknowledge before waiting on the per-guild command queue or network calls.
      await deferResponse();
      const argument = interaction.isModalSubmit()
        ? interaction.fields.getTextInputValue("value").trim()
        : selectedUrl;
      let first = true;
      await handle({
        content: `!music ${action}${argument ? ` ${argument}` : ""}`,
        guild: interaction.guild,
        author: interaction.user,
        expectedPlaylistId: selectedPlaylistId,
        targetPlaylistId: selectedDestinationId,
        reply: async (payload) => {
          if (first || !["list", "queue"].includes(action)) {
            first = false;
            await editResponse(payload);
          } else await followUp({ ...payload, flags: MessageFlags.Ephemeral });
        },
      });
    } catch {
      const payload = {
        content: "Не удалось выполнить действие. Откройте !music и попробуйте снова.",
        flags: MessageFlags.Ephemeral as const,
      };
      if (privateSource && (interaction.deferred || interaction.replied))
        await editResponse({ content: payload.content }).catch(() => {});
      else if (interaction.deferred || interaction.replied) await followUp(payload).catch(() => {});
      else await respond(payload).catch(() => {});
    }
    return true;
  }
  return {
    handle,
    handleInteraction,
    /** Cancel imports and playback immediately, then await process and command cleanup. */
    stop() {
      if (shutdownTask) return shutdownTask;
      const pipelines = [...states.values()].flatMap((s) =>
        s.playback ? [s.playback.exited] : [],
      );
      closed = true;
      imports.abort();
      for (const timer of refreshTimers.values()) clearTimeout(timer);
      refreshTimers.clear();
      panels.clear();
      searchChoices.clear();
      removalMenus.clear();
      playlistMenus.clear();
      playlistDeletions.clear();
      for (const s of states.values()) disconnect(s);
      shutdownTask = Promise.allSettled([
        ...pipelines,
        ...locks.values(),
        ...metadataTasks,
        ...listingTasks,
      ]).then(() => {});
      return shutdownTask;
    },
  };
}
