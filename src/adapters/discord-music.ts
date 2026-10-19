/** @file Handle per-guild music commands, interactive panels, playlist storage and voice playback. */
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
import { rename } from "node:fs/promises";
import { resolvePath } from "../core/paths.ts";
import { createMusicPipeline, runMusicCommand } from "./music-process.ts";
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

/** Validate a bounded HTTPS media URL against supported music hosts.
 * @throws When the protocol, host, credentials, port or URL length is unsupported. */
export function musicUrl(input: string) {
  const url = new URL(input.replace(/^<|>$/g, ""));
  if (
    input.length > 500 ||
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.port ||
    !(
      /^[a-z0-9-]+\.bandcamp\.com$/.test(url.hostname) ||
      [
        "bandcamp.com",
        "audiomack.com",
        "www.audiomack.com",
        "music.yandex.ru",
        "music.yandex.com",
        "music.yandex.kz",
        "music.yandex.by",
        "youtube.com",
        "www.youtube.com",
        "m.youtube.com",
        "music.youtube.com",
        "youtu.be",
        "soundcloud.com",
        "www.soundcloud.com",
        "on.soundcloud.com",
      ].includes(url.hostname)
    )
  ) {
    throw new Error(
      "Нужна HTTPS-ссылка на YouTube, SoundCloud, Bandcamp, Audiomack или Яндекс Музыку.",
    );
  }
  return url.href;
}

/** Normalize YouTube URLs with a list parameter to a playlist URL, or return null for single tracks. */
export function youtubePlaylistUrl(input: string): string | null {
  const url = new URL(musicUrl(input));
  const id = url.searchParams.get("list");
  if (
    !["youtube.com", "www.youtube.com", "m.youtube.com", "music.youtube.com", "youtu.be"].includes(
      url.hostname,
    ) ||
    !id
  )
    return null;
  if (!/^[A-Za-z0-9_-]{2,150}$/.test(id))
    throw new Error("Некорректная ссылка на YouTube-плейлист.");
  return `https://www.youtube.com/playlist?list=${id}`;
}

type PlaylistResult = { tracks: string[]; truncated: boolean; skipped: number };
type PlaylistRunner = (args: string[], signal: AbortSignal) => Promise<string>;
const runPlaylist: PlaylistRunner = (args, signal) =>
  runMusicCommand(["yt-dlp", ...args], { signal });

/** Extract the first bounded playlist entries in source order without downloading audio.
 * @param limit Remaining capacity in the saved guild playlist, from 1 to 100.
 * @param signal Cancels metadata extraction during shutdown.
 * @returns Canonical video URLs and counts describing skipped or truncated entries.
 * @throws For inaccessible, malformed or empty playlists. */
export async function loadYouTubePlaylist(
  url: string,
  limit: number,
  signal: AbortSignal,
  run: PlaylistRunner = runPlaylist,
): Promise<PlaylistResult> {
  const canonical = youtubePlaylistUrl(url);
  if (!canonical || !Number.isInteger(limit) || limit < 1 || limit > 100)
    throw new Error("Некорректный запрос плейлиста.");
  let data: { entries?: unknown[] };
  try {
    data = JSON.parse(
      await run(
        [
          "--ignore-config",
          "--flat-playlist",
          "--yes-playlist",
          "--ignore-errors",
          "--dump-single-json",
          "--skip-download",
          "--socket-timeout",
          "15",
          "--retries",
          "1",
          "--playlist-end",
          String(limit + 1),
          "--",
          canonical,
        ],
        signal,
      ),
    );
  } catch {
    throw new Error(
      "Не удалось загрузить YouTube-плейлист. Проверьте ссылку, доступность плейлиста и установку yt-dlp.",
    );
  }
  if (!data || !Array.isArray(data.entries)) throw new Error("YouTube не вернул список треков.");
  const tracks: string[] = [];
  let skipped = 0;
  for (const value of data.entries.slice(0, limit)) {
    const entry = value as { id?: unknown; availability?: string; title?: unknown } | null;
    if (
      !entry ||
      typeof entry.id !== "string" ||
      !/^[A-Za-z0-9_-]{11}$/.test(entry.id) ||
      (typeof entry.title === "string" &&
        /^\[(?:deleted|private) video\]$/i.test(entry.title.trim())) ||
      ["private", "premium_only", "subscriber_only", "needs_auth"].includes(
        entry.availability ?? "",
      )
    ) {
      skipped++;
      continue;
    }
    tracks.push(`https://www.youtube.com/watch?v=${entry.id}`);
  }
  if (!tracks.length) throw new Error("В плейлисте нет доступных треков.");
  return { tracks, truncated: data.entries.length > limit, skipped };
}

/** A display title and validated playable URL returned by a music search. */
export type MusicSearchResult = { title: string; url: string; duration?: number };

/** Search up to five public YouTube or SoundCloud tracks without downloading audio.
 * Prefix the query with sc: for SoundCloud; cancellation stops metadata extraction. */
export async function searchMusic(
  query: string,
  signal: AbortSignal,
  run: PlaylistRunner = runPlaylist,
): Promise<MusicSearchResult[]> {
  const soundcloud = /^sc:/i.test(query);
  const text = query.replace(/^(sc:|yt:)/i, "").trim();
  if (!text || text.length > 200) throw new Error("Введите название трека (до 200 символов).");
  let data: { entries?: unknown[] };
  try {
    data = JSON.parse(
      await run(
        [
          "--ignore-config",
          "--flat-playlist",
          "--dump-single-json",
          "--skip-download",
          "--socket-timeout",
          "15",
          "--retries",
          "1",
          "--",
          `${soundcloud ? "scsearch5" : "ytsearch5"}:${text}`,
        ],
        signal,
      ),
    );
  } catch {
    throw new Error(
      "Не удалось выполнить поиск. Проверьте доступность сервиса и установку yt-dlp.",
    );
  }
  const results: MusicSearchResult[] = [];
  for (const value of Array.isArray(data?.entries) ? data.entries.slice(0, 5) : []) {
    if (!value || typeof value !== "object") continue;
    const entry = value as {
      id?: unknown;
      title?: unknown;
      url?: unknown;
      webpage_url?: unknown;
      duration?: unknown;
    };
    try {
      const url = musicUrl(
        !soundcloud && typeof entry.id === "string" && /^[A-Za-z0-9_-]{11}$/.test(entry.id)
          ? `https://www.youtube.com/watch?v=${entry.id}`
          : String(entry.webpage_url ?? entry.url ?? ""),
      );
      results.push({
        ...(typeof entry.duration === "number" &&
        Number.isFinite(entry.duration) &&
        entry.duration >= 0
          ? { duration: Math.floor(entry.duration) }
          : {}),
        url,
        title:
          typeof entry.title === "string" ? entry.title.replace(/\s+/g, " ").slice(0, 150) : url,
      });
    } catch {
      /* Skip malformed or unsupported provider entries. */
    }
  }
  if (!results.length) throw new Error("Ничего не найдено. Уточните название трека.");
  return results;
}

const help = [
  "🎵 **Музыка**",
  "`!music` — открыть панель с кнопками",
  "",
  "**Плейлист и поиск**",
  "`!music add <ссылка>` — сохранить трек или YouTube-плейлист",
  "`!music search <название>` — найти трек; `sc: <название>` — поиск в SoundCloud",
  "`!music list` — показать сохранённый плейлист",
  "`!music jump <номер>` — включить выбранный трек",
  "`!music remove <номер>` — удалить трек",
  "",
  "**Воспроизведение**",
  "`!music play [ссылка]` — включить музыку",
  "`!music pause` / `!music resume` — пауза / продолжить",
  "`!music skip` — следующий трек",
  "`!music stop` — остановить музыку",
  "`!music leave` — выйти из голосового канала",
  "`!music queue` — показать очередь",
  "",
  "**Режимы очереди**",
  "`!music repeat off|track|all` — повтор выключен / одного трека / всей очереди",
  "`!music shuffle on|off` — включить / выключить случайный порядок",
  "`!music mix` — перемешать оставшуюся очередь",
  "",
  "Для управления войдите в голосовой канал бота.",
].join("\n");

type MusicRequest = {
  expectedTracks?: string[];
  content: string;
  guild: Guild | null;
  author: Pick<User, "id">;
  reply: (payload: {
    content: string;
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
  }: {
    search?: typeof searchMusic;
    loadMetadata?: typeof loadMusicMetadata;
    onStatus?: (statuses: MusicStatus[]) => void;
    loadPlaylist?: (url: string, limit: number, signal: AbortSignal) => Promise<PlaylistResult>;
  } = {},
) {
  const states = new Map<string, ReturnType<typeof newState>>();
  const searchChoices = new Map<
    string,
    { userId: string; guildId: string; urls: string[]; expires: number }
  >();
  const playlistMenus = new Map<
    string,
    { userId: string; guildId: string; tracks: string[]; expires: number }
  >();
  const removalMenus = new Map<
    string,
    { userId: string; guildId: string; tracks: string[]; expires: number }
  >();
  const metadataTasks = new Set<Promise<void>>();
  const listingTasks = new Set<Promise<void>>();
  const metadataCache = new Map<string, { value: MusicMetadata | null; expires: number }>();
  const listingLookups = new Map<string, Promise<MusicMetadata | null>>();
  /** Cache successful lookups for an hour and provider failures for a minute, bounded to 500 URLs. */
  async function trackMetadata(url: string, signal: AbortSignal): Promise<MusicMetadata | null> {
    signal.throwIfAborted();
    const cached = metadataCache.get(url);
    if (cached && cached.expires > Date.now()) return cached.value;
    let value: MusicMetadata | null = null;
    try {
      value = await loadMetadata(url, signal);
    } catch {
      signal.throwIfAborted();
    }
    signal.throwIfAborted();
    while (metadataCache.size >= 500) metadataCache.delete(metadataCache.keys().next().value!);
    metadataCache.set(url, { value, expires: Date.now() + (value ? 3_600_000 : 60_000) });
    return value;
  }
  /** Coalesce list lookups while keeping playback cancellation independent. */
  function listingMetadata(url: string): Promise<MusicMetadata | null> {
    const existing = listingLookups.get(url);
    if (existing) return existing;
    const task = trackMetadata(url, imports.signal).finally(() => listingLookups.delete(url));
    listingLookups.set(url, task);
    return task;
  }
  /** Render a stable queue snapshot with at most three concurrent lookups and bounded Discord pages. */
  async function sendTrackList(
    tracks: string[],
    current: string,
    empty: string,
    reply: (
      text: string,
      components?: ActionRowBuilder<StringSelectMenuBuilder>[],
    ) => Promise<void>,
    selectionToken?: string,
  ) {
    const urls = [...new Set([...(current ? [current] : []), ...tracks])];
    const metadata = new Map<string, MusicMetadata | null>();
    let cursor = 0;
    await Promise.all(
      Array.from({ length: Math.min(3, urls.length) }, async () => {
        while (cursor < urls.length) {
          imports.signal.throwIfAborted();
          const url = urls[cursor++];
          metadata.set(url, await listingMetadata(url));
        }
      }),
    );
    if (closed) return;
    const lines = [
      ...(current ? [`Сейчас: ${formatMusicTrack(current, metadata.get(current) ?? null)}`] : []),
      ...(tracks.length
        ? tracks.map((url, i) => `${i + 1}. ${formatMusicTrack(url, metadata.get(url) ?? null)}`)
        : [empty]),
    ];
    let page = "";
    for (const line of lines) {
      if (page && page.length + line.length + 1 > 1900) {
        await reply(page);
        page = "";
      }
      page += `${page ? "\n" : ""}${line}`;
    }
    if (page && !closed) {
      const components: ActionRowBuilder<StringSelectMenuBuilder>[] = [];
      if (selectionToken)
        for (let offset = 0; offset < tracks.length; offset += 25) {
          const select = new StringSelectMenuBuilder()
            .setCustomId(`music:jump:${selectionToken}:${offset}`)
            .setPlaceholder(`Включить трек ${offset + 1}–${Math.min(offset + 25, tracks.length)}`)
            .addOptions(
              tracks.slice(offset, offset + 25).map((url, i) => ({
                label: `${offset + i + 1}. ${metadata.get(url)?.title ?? url}`.slice(0, 100),
                value: String(offset + i),
                description: formatMusicTrack(url, metadata.get(url) ?? null)
                  .split(" · ")
                  .at(-1)!
                  .slice(0, 100),
              })),
            );
          components.push(new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select));
        }
      await reply(page, components.length ? components : undefined);
    }
  }
  const locks = new Map<string, Promise<unknown>>();
  let closed = false;
  let shutdownTask: Promise<void> | undefined;
  const imports = new AbortController();
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
  /** Render current playback controls; disable actions that cannot apply to the current state. */
  function panel(s: State) {
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
        if (message && state)
          void message.edit(panel(state)).catch(() => {
            if (panels.get(guildId) === message) panels.delete(guildId);
          });
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
    const match = (message.content ?? "").trim().match(/^!music(?:\s+(\w+))?(?:\s+([\s\S]*))?$/i);
    if (!match) return false;
    const reply = async (content: string) => {
      await message.reply({ content, allowedMentions: { parse: [], repliedUser: false } });
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
        let command = (match[1] ?? "panel").toLowerCase();
        const argument = match[2]?.trim() ?? "";
        if (command === "help") {
          await reply(help);
          return;
        }
        let s = states.get(guild.id);
        const file = resolvePath(`music_${guild.id}.json`, directory);
        if (!s) {
          s = newState();
          s.guildName = guild.name;
          try {
            const saved = await Bun.file(file).json();
            if (!Array.isArray(saved) || saved.length > 100) throw new Error("Invalid playlist");
            s.tracks = saved.map(musicUrl);
          } catch (error) {
            if ((error as { code?: string }).code !== "ENOENT")
              throw new Error("Не удалось прочитать сохранённый плейлист.");
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
          const posted = await message.reply(panel(s));
          if (posted && typeof (posted as Message).edit === "function" && (posted as Message).id) {
            const old = panels.get(guild.id);
            panels.set(guild.id, posted as Message);
            if (old && old.id !== (posted as Message).id)
              await old.edit({ components: [] }).catch(() => {});
          }
          return;
        }
        if (command === "list" || command === "queue") {
          const snapshot = [...(command === "queue" ? s.pending : s.tracks)];
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
              await message.reply({
                content,
                components,
                allowedMentions: { parse: [], repliedUser: false },
              });
            },
            selectionToken,
          )
            .catch(async () => {
              if (!closed) await reply("Не удалось показать список треков.").catch(() => {});
            })
            .finally(() => listingTasks.delete(listingTask!));
          listingTasks.add(listingTask);
          return;
        }
        const channel = await requireVoiceChannel(guild, message.author.id);
        if (command === "search") {
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
          await message.reply({
            content: "Выберите трек для добавления в плейлист.",
            components: [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select)],
            allowedMentions: { parse: [], repliedUser: false },
          });
          return;
        }
        const save = async (tracks: string[]) => {
          await Bun.write(`${file}.tmp`, JSON.stringify(tracks, null, 2), { createPath: true });
          await rename(`${file}.tmp`, file);
          s.tracks = tracks;
        };
        if (["toggle", "pause", "resume", "skip"].includes(command) && !s.current)
          throw new Error("Сейчас ничего не играет. Нажмите ▶️.");
        if (command === "toggle")
          command =
            s.player.state.status === AudioPlayerStatus.Paused ||
            s.player.state.status === AudioPlayerStatus.AutoPaused
              ? "resume"
              : "pause";
        let added: string[] = [];
        if (command === "play" && s.current)
          throw new Error("Музыка уже играет. Используйте add, skip или stop.");
        if (command === "add" || (command === "play" && argument)) {
          let url: string;
          try {
            url = musicUrl(argument);
          } catch {
            throw new Error("Укажите HTTPS-ссылку на трек поддерживаемого сервиса.");
          }
          if (s.tracks.length >= 100) throw new Error("В плейлисте уже 100 треков.");
          const playlist = youtubePlaylistUrl(url);
          let note = "";
          if (playlist) {
            await reply("Загружаю YouTube-плейлист…");
            s.importing = true;
            s.error = "";
            publish();
            let result: PlaylistResult;
            try {
              result = await loadPlaylist(playlist, 100 - s.tracks.length, imports.signal);
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
          await save([...s.tracks, ...added]);
          await reply(`Добавлено треков: ${added.length}. В плейлисте: ${s.tracks.length}.${note}`);
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
            if (command === "play" && s.current)
              throw new Error("Музыка уже играет. Используйте add, skip или stop.");
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
            await reply(help);
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
    try {
      if (!interaction.guild) {
        await interaction.reply({
          content: "Музыка доступна только на сервере.",
          flags: MessageFlags.Ephemeral,
        });
        return true;
      }
      if (
        interaction.isButton() &&
        !interaction.customId.startsWith("music:pick:") &&
        !interaction.customId.startsWith("music:delete:") &&
        !panels.has(interaction.guild.id) &&
        interaction.message?.id
      ) {
        panels.set(interaction.guild.id, interaction.message);
      }
      let action = interaction.customId.slice("music:".length);
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
          await interaction.reply({
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
          await interaction.reply({
            content: "Некорректный выбор трека.",
            flags: MessageFlags.Ephemeral,
          });
          return true;
        }
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        await handle({
          content: `!music jump ${index + 1}`,
          guild: interaction.guild,
          author: interaction.user,
          expectedTracks: menu.tracks,
          reply: async (payload) => {
            await interaction.editReply(payload);
          },
        });
        return true;
      }
      if ((interaction.isButton() && action === "remove") || action.startsWith("delete:")) {
        try {
          await requireVoiceChannel(interaction.guild, interaction.user.id);
        } catch (error) {
          await interaction.reply({
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
          await interaction.reply({
            content: "Список удаления недоступен. Откройте его заново.",
            flags: MessageFlags.Ephemeral,
          });
          return true;
        }
        if (token && (interaction.isButton() || interaction.isStringSelectMenu()))
          await interaction.deferUpdate();
        else await interaction.deferReply({ flags: MessageFlags.Ephemeral });
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
            tracks: [...tracks],
            expires: Date.now() + 300_000,
          };
        }
        if (
          menu.tracks.length !== tracks.length ||
          menu.tracks.some((url, i) => url !== tracks[i])
        ) {
          await interaction.editReply({ content: "Плейлист изменился. Откройте удаление заново." });
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
            await interaction.editReply({ content: "Некорректный выбор трека." });
            return true;
          }
          await handle({
            content: `!music remove ${index + 1}`,
            guild: interaction.guild,
            author: interaction.user,
            expectedTracks: menu.tracks,
            reply: async (payload) => {
              await interaction.editReply(payload);
            },
          });
          return true;
        }
        if (!tracks.length) {
          await interaction.editReply({ content: "Плейлист пуст." });
          return true;
        }
        const page = Number(pageText);
        if (!Number.isInteger(page) || page < 0 || page * 25 >= menu.tracks.length) {
          await interaction.editReply({ content: "Такой страницы нет." });
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
        await interaction.editReply({
          content: `Выберите трек для удаления · страница ${page + 1}/${Math.ceil(menu.tracks.length / 25)}`,
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
      if (interaction.isStringSelectMenu?.() && action.startsWith("pick:")) {
        const choice = searchChoices.get(action.slice(5));
        if (
          !choice ||
          choice.expires <= Date.now() ||
          choice.userId !== interaction.user.id ||
          choice.guildId !== interaction.guild.id
        ) {
          await interaction.reply({
            content: "Этот результат недоступен. Выполните свой поиск заново.",
            flags: MessageFlags.Ephemeral,
          });
          return true;
        }
        const value = interaction.values[0] ?? "";
        if (!/^\d+$/.test(value) || !choice.urls[Number(value)]) {
          await interaction.reply({
            content: "Некорректный выбор трека.",
            flags: MessageFlags.Ephemeral,
          });
          return true;
        }
        selectedUrl = choice.urls[Number(value)];
        action = "add";
      }
      if (interaction.isButton() && !selectedUrl && ["add", "remove", "search"].includes(action)) {
        try {
          await requireVoiceChannel(interaction.guild, interaction.user.id);
        } catch (error) {
          await interaction.reply({
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
              ? "Название трека (sc: для SoundCloud)"
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
        ].includes(action) ||
        (interaction.isModalSubmit() && !["add", "remove", "search"].includes(action))
      ) {
        await interaction.reply({
          content: "Неизвестное действие. Откройте !music заново.",
          flags: MessageFlags.Ephemeral,
        });
        return true;
      }
      // Acknowledge before waiting on the per-guild command queue or network calls.
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const argument = interaction.isModalSubmit()
        ? interaction.fields.getTextInputValue("value").trim()
        : selectedUrl;
      let first = true;
      await handle({
        content: `!music ${action}${argument ? ` ${argument}` : ""}`,
        guild: interaction.guild,
        author: interaction.user,
        reply: async (payload) => {
          if (first) {
            first = false;
            await interaction.editReply(payload);
          } else await interaction.followUp({ ...payload, flags: MessageFlags.Ephemeral });
        },
      });
    } catch {
      const payload = {
        content: "Не удалось выполнить действие. Откройте !music и попробуйте снова.",
        flags: MessageFlags.Ephemeral as const,
      };
      if (interaction.deferred || interaction.replied)
        await interaction.followUp(payload).catch(() => {});
      else await interaction.reply(payload).catch(() => {});
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
