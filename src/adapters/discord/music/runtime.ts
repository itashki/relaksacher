/** @file Own guild player state, voice playback, telemetry and music shutdown. */
import type { MusicStatus } from "../../../core/music/status.ts";
import {
  createPlaybackQueue,
  advanceQueue,
  type AdvanceReason,
} from "../../../core/music/queue.ts";
import { loadMusicMetadata, type MusicMetadata } from "../../music/metadata.ts";
import { createMusicLibrary } from "../../music/library.ts";
import { musicMessageComponents } from "./messages.ts";
import { loadYouTubePlaylist, type PlaylistResult } from "../../music/youtube-playlist.ts";
import { searchMusic } from "../../music/search.ts";
import { createMusicTrackList } from "./track-list.ts";
import { panel } from "./panel.ts";
import { createMusicPipeline } from "../../music/process.ts";
import { downloadPlaylist } from "../../music/transfer.ts";
import { type Message, type Guild, ChannelType } from "discord.js";
import {
  createAudioPlayer,
  createAudioResource,
  AudioPlayerStatus,
  VoiceConnectionStatus,
  StreamType,
  type VoiceConnection,
} from "@discordjs/voice";

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
/** Mutable state owned by one guild player and shared by serialized command handlers. */
export type MusicState = ReturnType<typeof newState>;

export function createMusicRuntime(
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
  function refreshGuild(state: MusicState) {
    for (const [guildId, candidate] of states)
      if (candidate === state) {
        refresh(guildId);
        break;
      }
  }
  /** Clear the playback deadline and stop the active source/encoder pipeline without advancing the queue. */
  function cleanup(s: MusicState) {
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
  function disconnect(s: MusicState) {
    s.pending = [];
    s.current = "";
    s.transitionPending = false;
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
  function next(s: MusicState, notify: (text: string) => void) {
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
  return {
    states,
    searchChoices,
    playlistMenus,
    removalMenus,
    playlistDeletions,
    metadataTasks,
    listingTasks,
    locks,
    imports,
    trackMetadata,
    listingMetadata,
    sendTrackList,
    panels,
    refreshTimers,
    publish,
    refresh,
    refreshGuild,
    newState,
    cleanup,
    disconnect,
    next,
    requireVoiceChannel,
    directory,
    loadPlaylist,
    search,
    downloadPlaylistFile,
    get closed() {
      return closed;
    },
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
/** Shared controller services; closed is read live rather than captured when handlers are created. */
export type MusicRuntime = ReturnType<typeof createMusicRuntime>;
