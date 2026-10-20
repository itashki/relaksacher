/** @file Resolve Discord user mentions to readable names before speech synthesis. */
import type { Message } from "discord.js";

/** Replace <@ID>/<@!ID> with the guild nickname, global name or username.
 * Resolve each unique ID once per utterance, including users absent from the message's
 * mention collection (for example in generated replies). Failed lookups become
 * "пользователь" so unavailable accounts never have their internal IDs spoken. */
export async function discordSpeechText(text: string, source: Message): Promise<string> {
  const names = new Map<string, string>();
  for (const match of text.matchAll(/<@!?(\d{1,20})>/g)) {
    const id = match[1];
    if (names.has(id)) continue;
    let member = source.guild?.members.cache?.get(id) ?? source.mentions?.members?.get(id);
    if (!member && source.guild) {
      member = await source.guild.members.fetch(id).catch((): null => null);
    }
    let user =
      member?.user ?? source.mentions?.users?.get(id) ?? source.client?.users?.cache.get(id);
    if (!member?.displayName && !user && source.client?.users) {
      user = await source.client.users.fetch(id).catch((): null => null);
    }
    names.set(id, member?.displayName || user?.globalName || user?.username || "пользователь");
  }
  return text.replace(/<@!?(\d{1,20})>/g, (_, id: string) => names.get(id)!);
}
