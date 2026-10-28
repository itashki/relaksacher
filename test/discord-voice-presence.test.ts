/** @file Empty voice departures allow rejoining and cancel timers on shutdown. */
import { expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { Events, type Client, type VoiceState } from "discord.js";
import { type VoiceConnection } from "@discordjs/voice";
import { watchEmptyVoice } from "../src/adapters/discord/voice-presence.ts";

test("empty channels leave after grace period, rejoining and shutdown cancel departure", async () => {
  const client = new EventEmitter();
  let humans = false;
  let destroyed = 0;
  let cancelled = 0;
  const connection = {
    joinConfig: { channelId: "voice" },
    state: { status: "ready" },
    destroy: () => destroyed++,
  } as unknown as VoiceConnection;
  const guild = {
    id: "guild",
    channels: {
      cache: new Map([
        [
          "voice",
          {
            isVoiceBased: () => true,
            members: {
              some: (predicate: (member: { user: { bot: boolean } }) => boolean) =>
                predicate({ user: { bot: true } }) ||
                (humans && predicate({ user: { bot: false } })),
            },
          },
        ],
      ]),
    },
  };
  const emit = (from: string | null, to: string | null) =>
    client.emit(
      Events.VoiceStateUpdate,
      { guild, channelId: from } as unknown as VoiceState,
      { guild, channelId: to } as unknown as VoiceState,
    );
  const stop = watchEmptyVoice(client as unknown as Client, () => cancelled++, {
    delayMs: 20,
    connectionFor: () => connection,
  });
  try {
    emit("voice", null);
    expect(destroyed).toBe(0);
    humans = true;
    emit(null, "voice");
    await Bun.sleep(40);
    expect(destroyed).toBe(0);
    humans = false;
    emit("other", null);
    await Bun.sleep(40);
    expect(destroyed).toBe(0);
    emit("voice", null);
    await Bun.sleep(40);
    expect(destroyed).toBe(1);
    expect(cancelled).toBe(1);
    emit("voice", null);
    stop();
    await Bun.sleep(40);
    expect(destroyed).toBe(1);
  } finally {
    stop();
  }
});
