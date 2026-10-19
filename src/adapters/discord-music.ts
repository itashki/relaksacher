/** @file Handle per-guild music commands, interactive panels, playlist storage and voice playback. */
import {
  createPlaybackQueue,
  startQueue,
  advanceQueue,
  shuffled,
  type AdvanceReason,
  type RepeatMode,
} from "../core/music-queue.ts";
import type { MusicStatus } from "../core/music-status.ts";
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

/** Validate a bounded HTTPS media URL against supported YouTube and SoundCloud hosts.
 * @throws When the protocol, host, credentials, port or URL length is unsupported. */
export function musicUrl(input: string) {
  const url = new URL(input.replace(/^<|>$/g, ""));
  if (
    input.length > 500 ||
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.port ||
    ![
      "youtube.com",
      "www.youtube.com",
      "m.youtube.com",
      "music.youtube.com",
      "youtu.be",
      "soundcloud.com",
      "www.soundcloud.com",
      "on.soundcloud.com",
    ].includes(url.hostname)
  ) {
    throw new Error("Нужна HTTPS-ссылка на YouTube или SoundCloud.");
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
    const entry = value as { id?: unknown; availability?: string } | null;
    if (
      !entry ||
      typeof entry.id !== "string" ||
      !/^[A-Za-z0-9_-]{11}$/.test(entry.id) ||
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

const help =
  "🎵 !music — панель с кнопками; !music add <ссылка> — сохранить трек или YouTube-плейлист; !music list — плейлист; !music remove <номер> — удалить; !music play [ссылка] — включить; !music pause / resume / skip / stop / leave; !music repeat off|track|all; !music shuffle on|off; !music mix — перемешать очередь; !music queue — очередь. Для управления войдите в голосовой канал бота.";

type MusicRequest = {
  content: string;
  guild: Guild | null;
  author: Pick<User, "id">;
  reply: (payload: {
    content: string;
    components?: ActionRowBuilder<ButtonBuilder>[];
    allowedMentions: { parse: never[]; repliedUser: boolean };
  }) => Promise<unknown>;
};

/** Persistent guild playlists, independent of model generation. */
export function createDiscordMusic(
  directory: string,
  {
    loadPlaylist = loadYouTubePlaylist,
    onStatus = () => {},
  }: {
    onStatus?: (statuses: MusicStatus[]) => void;
    loadPlaylist?: (url: string, limit: number, signal: AbortSignal) => Promise<PlaylistResult>;
  } = {},
) {
  const states = new Map<string, ReturnType<typeof newState>>();
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
      label: string,
      style = ButtonStyle.Secondary,
      disabled = false,
    ) =>
      new ButtonBuilder()
        .setCustomId(`music:${action}`)
        .setLabel(label)
        .setStyle(style)
        .setDisabled(disabled);
    return {
      content:
        `🎵 **Музыкальный плеер**\n${active ? `${paused ? "⏸ На паузе" : "▶ Сейчас"}: <${s.current}>` : "⏹ Воспроизведение остановлено"}\n` +
        `Сохранено: **${s.tracks.length}/100** · Далее в очереди: **${s.pending.length}**\n` +
        `Повтор: **${{ off: "выкл", track: "трек", all: "вся очередь" }[s.repeat]}** · Случайный порядок: **${s.shuffle ? "вкл" : "выкл"}**\n` +
        "Добавьте ссылку на YouTube, SoundCloud или YouTube-плейлист. Для управления войдите в голосовой канал бота.",
      components: [
        new ActionRowBuilder<ButtonBuilder>().addComponents(
          button("play", "▶ Включить", ButtonStyle.Success, active || !s.tracks.length),
          button("toggle", paused ? "▶ Продолжить" : "⏸ Пауза", ButtonStyle.Primary, !active),
          button("skip", "⏭ Далее", ButtonStyle.Secondary, !active),
          button("stop", "⏹ Остановить", ButtonStyle.Danger, !s.connection),
        ),
        new ActionRowBuilder<ButtonBuilder>().addComponents(
          button("add", "＋ Добавить"),
          button("remove", "− Удалить", ButtonStyle.Secondary, !s.tracks.length),
          button("list", "☷ Плейлист"),
          button("panel", "↻ Обновить"),
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
  /** Create independent player and queue state for a guild; no voice connection is opened yet. */
  function newState() {
    const player = createAudioPlayer();
    return {
      ...createPlaybackQueue(),
      advanceReason: "finished" as AdvanceReason,
      guildName: "",
      channelName: "",
      importing: false,
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
    // No shell interpolation. yt-dlp resolves expiring media URLs at playback time.
    let playback: ReturnType<typeof createMusicPipeline> | null = null;
    let failed = false;
    const fail = () => {
      if (failed || (playback && s.playback !== playback)) return;
      failed = true;
      s.advanceReason = "failed";
      s.error = "Не удалось проиграть трек. Проверьте ссылку, yt-dlp и FFmpeg.";
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
          s.player.on(AudioPlayerStatus.Idle, () => next(state, notify));
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
          const tracks = command === "queue" ? s.pending : s.tracks;
          const lines = [
            ...(s.current ? [`Сейчас: <${s.current}>`] : []),
            ...(tracks.length
              ? tracks.map((url, i) => `${i + 1}. <${url}>`)
              : [command === "queue" ? "Очередь пуста." : "Плейлист пуст."]),
          ];
          let page = "";
          for (const line of lines) {
            if (page.length + line.length > 1900) {
              await reply(page);
              page = "";
            }
            page += `${page ? "\n" : ""}${line}`;
          }
          if (page) await reply(page);
          return;
        }
        const member = await guild.members.fetch(message.author.id);
        const channel = member.voice.channel;
        if (!channel || channel.type !== ChannelType.GuildVoice)
          throw new Error("Сначала войдите в обычный голосовой канал.");
        if (s.connection && s.connection.joinConfig.channelId !== channel.id)
          throw new Error("Для управления войдите в голосовой канал бота.");
        const save = async (tracks: string[]) => {
          await Bun.write(`${file}.tmp`, JSON.stringify(tracks, null, 2), { createPath: true });
          await rename(`${file}.tmp`, file);
          s.tracks = tracks;
        };
        if (["toggle", "pause", "resume", "skip"].includes(command) && !s.current)
          throw new Error("Сейчас ничего не играет. Нажмите «Включить».");
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
            throw new Error("Укажите HTTPS-ссылку на трек YouTube или SoundCloud.");
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
            const index = Number(argument);
            if (!/^\d+$/.test(argument) || index < 1 || index > s.tracks.length)
              throw new Error("Укажите номер трека из !music list.");
            await save(s.tracks.filter((_, i) => i !== index - 1));
            await reply("Трек удалён из плейлиста.");
            break;
          }
          case "play": {
            if (s.current) throw new Error("Музыка уже играет. Используйте add, skip или stop.");
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
            startQueue(s, argument ? added : s.tracks);
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
    return true;
  }
  /** Acknowledge music buttons or modal submissions and route them through the shared command handler. */
  async function handleInteraction(interaction: Interaction): Promise<boolean> {
    if (
      (!interaction.isButton() && !interaction.isModalSubmit()) ||
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
      if (interaction.isButton() && !panels.has(interaction.guild.id) && interaction.message?.id) {
        panels.set(interaction.guild.id, interaction.message);
      }
      const action = interaction.customId.slice("music:".length);
      if (interaction.isButton() && (action === "add" || action === "remove")) {
        const input = new TextInputBuilder()
          .setCustomId("value")
          .setLabel(
            action === "add" ? "Ссылка на трек или YouTube-плейлист" : "Номер трека из плейлиста",
          )
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setMaxLength(action === "add" ? 500 : 3)
          .setPlaceholder(
            action === "add" ? "https://www.youtube.com/playlist?list=…" : "Например: 3",
          );
        await interaction.showModal(
          new ModalBuilder()
            .setCustomId(`music:${action}`)
            .setTitle(action === "add" ? "Добавить музыку" : "Удалить трек")
            .addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(input)),
        );
        return true;
      }
      if (
        ![
          "play",
          "toggle",
          "skip",
          "stop",
          "list",
          "panel",
          "add",
          "remove",
          "repeat",
          "shuffle",
          "mix",
          "queue",
        ].includes(action) ||
        (interaction.isModalSubmit() && !["add", "remove"].includes(action))
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
        : "";
      let first = true;
      await handle({
        content: `!music ${action}${argument ? ` ${argument}` : ""}`,
        guild: interaction.guild,
        author: interaction.user,
        reply: async (payload) => {
          // Refresh the shared panel; private confirmations never replace it.
          if (action === "panel")
            payload = {
              content: "Панель обновлена. Чтобы опубликовать новую, отправьте !music.",
              allowedMentions: { parse: [], repliedUser: false },
            };
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
      for (const s of states.values()) disconnect(s);
      shutdownTask = Promise.allSettled([...pipelines, ...locks.values()]).then(() => {});
      return shutdownTask;
    },
  };
}
