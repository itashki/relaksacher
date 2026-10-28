/** @file Leave voice channels after a short grace period without human listeners. */
import { Events, type Client, type VoiceState } from "discord.js";
import { getVoiceConnection, VoiceConnectionStatus } from "@discordjs/voice";

/** Watch shared or owned clients; dispose listeners and pending departures on shutdown. */
export function watchEmptyVoice(
  client: Client,
  cancelSpeech: (guildId: string) => void,
  { delayMs = 10_000, connectionFor = getVoiceConnection } = {},
) {
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  const onVoiceState = (oldState: VoiceState, newState: VoiceState) => {
    const guild = newState.guild;
    const connection = connectionFor(guild.id);
    const channelId = connection?.joinConfig.channelId;
    if (!connection || !channelId) return;
    if (oldState.channelId !== channelId && newState.channelId !== channelId) return;
    clearTimeout(timers.get(guild.id));
    timers.delete(guild.id);
    const empty = () => {
      const channel = guild.channels.cache.get(channelId);
      return channel?.isVoiceBased() && !channel.members.some((member) => !member.user.bot);
    };
    if (!empty()) return;
    timers.set(
      guild.id,
      setTimeout(() => {
        timers.delete(guild.id);
        if (
          connectionFor(guild.id) !== connection ||
          connection.joinConfig.channelId !== channelId ||
          connection.state.status === VoiceConnectionStatus.Destroyed ||
          !empty()
        )
          return;
        cancelSpeech(guild.id);
        connection.destroy();
      }, delayMs),
    );
  };
  client.on(Events.VoiceStateUpdate, onVoiceState);
  return () => {
    client.off(Events.VoiceStateUpdate, onVoiceState);
    for (const timer of timers.values()) clearTimeout(timer);
    timers.clear();
  };
}
