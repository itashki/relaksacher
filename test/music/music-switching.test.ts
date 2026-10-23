/** @file Playlist commits replace upcoming playback without touching the current player or source. */
import { expect, test } from "bun:test";
import { Readable } from "node:stream";
import { ChannelType, type Guild } from "discord.js";
import type { VoiceConnection } from "@discordjs/voice";
import { createMusicRuntime } from "../../src/adapters/discord/music/runtime.ts";
import { createMusicCommandHandler } from "../../src/adapters/discord/music/command-handler.ts";
import { temporaryDirectory } from "../support/temp.ts";

test("playlist switches replace upcoming tracks only while connected and preserve the playing source", async () => {
  const directory = await temporaryDirectory("music-switch-");
  const runtime = createMusicRuntime(directory);
  const handle = createMusicCommandHandler(runtime);
  const guild = {
    id: "switch",
    members: {
      fetch: async () => ({ voice: { channel: { id: "voice", type: ChannelType.GuildVoice } } }),
    },
  } as unknown as Guild;
  const replies: string[] = [];
  const send = (argument: string) =>
    handle({
      content: `!music ${argument}`,
      guild,
      author: { id: "owner" },
      reply: async (payload) => {
        replies.push(payload.content);
      },
    });
  try {
    await send("playlist create New");
    await send("playlist add New https://youtu.be/new");
    const state = runtime.states.get(guild.id)!;
    const originalId = state.library.activeId;
    state.connection = {
      joinConfig: { channelId: "voice" },
      state: { status: "ready" },
    } as VoiceConnection;
    state.current = "https://youtu.be/current";
    state.pending = ["https://youtu.be/old-next"];
    state.cycle = [state.current, ...state.pending];
    state.repeat = "track";
    const playerState = state.player.state;
    const source = {
      stream: Readable.from([]),
      exited: Promise.resolve<[number, number]>([0, 0]),
      stop: () => {
        throw new Error("Current source must keep playing");
      },
    };
    state.playback = source;
    await send("playlist use New");
    expect(replies.at(-1)).toContain("Активный плейлист");
    expect(state.current).toBe("https://youtu.be/current");
    expect(state.player.state).toBe(playerState);
    expect(state.playback).toBe(source);
    expect(state.pending).toEqual(["https://youtu.be/new"]);
    expect(state.cycle).toEqual(state.pending);
    expect(state.transitionPending).toBe(true);
    state.pending.push("keep-on-reselect");
    await send("playlist use New");
    expect(state.pending).toContain("keep-on-reselect");
    await send(`playlist select ${originalId}`);
    expect(state.pending).toEqual([]);
    expect(state.current).toBe("https://youtu.be/current");
    state.connection = null;
    state.playback = null;
    runtime.disconnect(state);
    await send("playlist use New");
    expect(state.pending).toEqual([]);
    expect(state.current).toBe("");
  } finally {
    const state = runtime.states.get(guild.id);
    if (state) {
      state.connection = null;
      state.playback = null;
    }
    await runtime.stop();
  }
});
