/** @file Route bounded Silero speech requests and temporarily borrow Discord's music connection. */
import { discordSpeechText } from "./speech-text.ts";
import { ChannelType, PermissionFlagsBits, type Message } from "discord.js";
import {
  AudioPlayerStatus,
  VoiceConnectionStatus,
  StreamType,
  createAudioPlayer,
  createAudioResource,
  entersState,
  getVoiceConnection,
  joinVoiceChannel,
} from "@discordjs/voice";
import PQueue from "p-queue";
import {
  createSpeechPipeline,
  speechSource,
  parseSpeechArguments,
  type SpeechOptions,
} from "../speech/silero.ts";

/** Verify the requester is in a regular channel and shares any existing bot connection. */
async function voiceChannel(message: Message) {
  if (!message.guild) throw new Error("TTS доступен только на Discord-сервере.");
  const member = await message.guild.members.fetch(message.author.id);
  const channel = member.voice.channel;
  if (!channel || channel.type !== ChannelType.GuildVoice)
    throw new Error("Сначала войдите в обычный голосовой канал.");
  const connection = getVoiceConnection(message.guild.id);
  if (connection && connection.joinConfig.channelId !== channel.id)
    throw new Error("Войдите в голосовой канал бота.");
  return channel;
}

/** Create per-guild speech queues. A stop cancels synthesis, playback and queued requests.
 * execute is injectable for command tests; production borrows the existing connection and restores music. */
export function createDiscordTts({
  execute,
  ...options
}: SpeechOptions & {
  execute?: (
    message: Message,
    text: string,
    signal: AbortSignal,
    speaker?: string,
  ) => Promise<void>;
} = {}) {
  const rooms = new Map<string, { queue: PQueue; controller: AbortController }>();
  let closed = false;
  /** Synthesize and play with a two-minute deadline, restoring only a music player we paused. */
  async function speak(message: Message, text: string, signal: AbortSignal, speaker?: string) {
    const channel = await voiceChannel(message);
    signal.throwIfAborted();
    const me = await message.guild.members.fetchMe();
    if (!channel.permissionsFor(me)?.has([PermissionFlagsBits.Connect, PermissionFlagsBits.Speak]))
      throw new Error("Боту нужны права Connect и Speak.");
    const source = speechSource(text, options, speaker);
    signal.throwIfAborted();
    const existing = getVoiceConnection(message.guild.id);
    const connection =
      existing ??
      joinVoiceChannel({
        channelId: channel.id,
        guildId: message.guild.id,
        adapterCreator: message.guild.voiceAdapterCreator,
        selfDeaf: true,
      });
    const player = createAudioPlayer();
    const deadline = AbortSignal.any([signal, AbortSignal.timeout(120000)]);
    const music =
      connection.state.status === VoiceConnectionStatus.Ready
        ? connection.state.subscription?.player
        : undefined;
    let paused = false;
    let pipeline: ReturnType<typeof createSpeechPipeline> | undefined;
    let subscription: ReturnType<typeof connection.subscribe>;
    try {
      await entersState(connection, VoiceConnectionStatus.Ready, deadline);
      deadline.throwIfAborted();
      if (music?.state.status === AudioPlayerStatus.Playing) paused = music.pause(true);
      subscription = connection.subscribe(player);
      await new Promise<void>((resolve, reject) => {
        const finish = (error?: Error) => {
          player.removeListener(AudioPlayerStatus.Idle, idle);
          player.removeListener("error", fail);
          deadline.removeEventListener("abort", abort);
          if (error) reject(error);
          else resolve();
        };
        const idle = () => finish();
        const fail = () =>
          finish(new Error("Не удалось воспроизвести речь. Проверьте TTS, модель и FFmpeg."));
        const abort = () =>
          finish(
            signal.aborted
              ? new DOMException("Озвучка остановлена", "AbortError")
              : new Error("Превышен тайм-аут озвучки."),
          );
        player.once(AudioPlayerStatus.Idle, idle);
        player.once("error", fail);
        deadline.addEventListener("abort", abort, { once: true });
        try {
          deadline.throwIfAborted();
          pipeline = createSpeechPipeline(source.command, fail, source.sampleRate);
          player.play(createAudioResource(pipeline.stream, { inputType: StreamType.Raw }));
        } catch {
          fail();
        }
      });
    } finally {
      pipeline?.stop();
      player.stop(true);
      if (connection.state.status !== VoiceConnectionStatus.Destroyed) {
        subscription?.unsubscribe();
        if (existing && music) {
          connection.subscribe(music);
          if (paused) music.unpause();
        } else if (!existing) connection.destroy();
      }
      await pipeline?.exited;
    }
  }
  return {
    /** Cancel active and queued speech for one guild, allowing later requests. */
    cancel(guildId: string) {
      const room = rooms.get(guildId);
      room?.controller.abort();
      if (room) room.controller = new AbortController();
    },
    /** Report queued or active speech, allowing callers to prevent conflicting music commands. */
    busy(guildId: string) {
      const room = rooms.get(guildId);
      return Boolean(room && (room.queue.pending || room.queue.size));
    },
    /** Recognize !tts/!озвучь text, replies and stop/стоп without involving the language model. */
    async handle(message: Message): Promise<boolean> {
      const match = message.content?.trim().match(/^!(?:tts|озвучь)(?:\s+([\s\S]*))?$/iu);
      if (!match) return false;
      const reply = (content: string) =>
        message.reply({ content, allowedMentions: { parse: [] as never[], repliedUser: false } });
      try {
        if (closed) return true;
        await voiceChannel(message);
        let room = rooms.get(message.guild.id);
        if (/^(?:stop|стоп)$/iu.test(match[1]?.trim() ?? "")) {
          room?.controller.abort();
          if (room) room.controller = new AbortController();
          await reply("⏹ Озвучка и очередь TTS остановлены.");
          return true;
        }
        const argument = parseSpeechArguments(match[1]);
        const source = !argument.text && message.reference ? await message.fetchReference() : null;
        const readingOwnMessage = Boolean(
          source?.author?.id && source.author.id === message.client?.user?.id,
        );
        const rawText = (argument.text || source?.content || "").trim();
        const text =
          rawText.length <= 2000 ? await discordSpeechText(rawText, source ?? message) : rawText;
        if (!text)
          throw new Error(
            "Используйте !tts [--speaker имя] <текст> или !tts ответом на текстовое сообщение.",
          );
        if (text.length > 2000) throw new Error("Для озвучки доступно до 2000 символов.");
        if (!room) {
          room = { queue: new PQueue({ concurrency: 1 }), controller: new AbortController() };
          rooms.set(message.guild.id, room);
        }
        if (room.queue.size >= 10) throw new Error("Очередь TTS заполнена.");
        const signal = room.controller.signal;
        if (!readingOwnMessage) await reply("🗣 Добавлено в очередь озвучки.");
        await room.queue.add(() => {
          signal.throwIfAborted();
          return (execute ?? speak)(message, text, signal, argument.speaker);
        });
      } catch (error) {
        if (!closed && error?.name !== "AbortError")
          await reply(error instanceof Error ? error.message : "Ошибка TTS.").catch(() => {});
      }
      return true;
    },
    /** Cancel every speech job before the Discord client and music connection are destroyed. */
    async stop() {
      closed = true;
      for (const room of rooms.values()) room.controller.abort();
      await Promise.all([...rooms.values()].map((room) => room.queue.onIdle()));
      rooms.clear();
    },
  };
}
