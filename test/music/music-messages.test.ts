/** @file Dismissal controls stay within Discord limits and delete messages without changing music state. */
import { expect, test } from "bun:test";
import {
  ActionRowBuilder,
  StringSelectMenuBuilder,
  type Guild,
  type Interaction,
} from "discord.js";
import { musicMessageComponents } from "../../src/adapters/discord/music/messages.ts";
import { createDiscordMusic } from "../../src/adapters/discord/music/index.ts";
import { temporaryDirectory } from "../support/temp.ts";

test("dismissal fits beside four track menus and repeated decoration adds no duplicate buttons", () => {
  const rows = Array.from({ length: 4 }, (_, i) =>
    new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId(`music:jump:${i}`)
        .addOptions({ label: "Track", value: "0" }),
    ),
  );
  const decorated = musicMessageComponents(rows);
  expect(rows).toHaveLength(4);
  expect(decorated).toHaveLength(5);
  expect(musicMessageComponents(decorated)).toBe(decorated);
  const navigation = musicMessageComponents(decorated, "music:back:panel");
  expect(navigation).toHaveLength(5);
  expect(navigation[4].toJSON().components).toHaveLength(2);
  expect(decorated[4].toJSON().components[0]).toMatchObject({
    custom_id: "music:dismiss",
    emoji: { name: "❌" },
  });
});

test("returning to a private player screen preserves the original shared panel", async () => {
  const music = createDiscordMusic(await temporaryDirectory("music-back-"));
  const calls: string[] = [];
  const guild = { id: "guild" } as Guild;
  try {
    await music.handle({
      content: "!music",
      guild,
      author: { id: "owner" },
      reply: async () => ({
        id: "shared",
        edit: async () => {
          calls.push("shared-edit");
        },
      }),
    });
    await music.handleInteraction({
      customId: "music:back:panel",
      isButton: () => true,
      isModalSubmit: () => false,
      isStringSelectMenu: () => false,
      guild,
      user: { id: "owner" },
      message: { id: "private", flags: { has: () => true } },
      deferUpdate: async () => {
        calls.push("deferUpdate");
      },
      editReply: async () => {
        calls.push("private-edit");
        return {
          id: "private",
          edit: async () => {
            calls.push("wrong-panel");
          },
        };
      },
      deleteReply: async () => {
        calls.push("wrong-delete");
      },
    } as unknown as Interaction);
    await Bun.sleep(350);
    expect(calls).toEqual(["deferUpdate", "private-edit", "shared-edit"]);
  } finally {
    await music.stop();
  }
});

test("dismissing a panel acknowledges and deletes it without voice access or subsequent panel refresh", async () => {
  const directory = await temporaryDirectory("music-dismiss-");
  const calls: string[] = [];
  const guild = {
    id: "guild",
    members: {
      fetch: async () => {
        throw new Error("must not check voice");
      },
    },
  } as unknown as Guild;
  const music = createDiscordMusic(directory);
  try {
    await music.handle({
      content: "!music",
      guild,
      author: { id: "owner" },
      reply: async () => ({
        id: "panel",
        edit: async () => {
          calls.push("edit");
        },
      }),
    });
    for (const currentGuild of [guild, null]) {
      expect(
        await music.handleInteraction({
          customId: "music:dismiss",
          isButton: () => true,
          isModalSubmit: () => false,
          isStringSelectMenu: () => false,
          guild: currentGuild,
          message: { id: "panel" },
          user: { id: "another-user" },
          deferUpdate: async () => {
            calls.push("ack");
          },
          deleteReply: async () => {
            calls.push("delete");
          },
        } as unknown as Interaction),
      ).toBe(true);
    }
    await Bun.sleep(350);
    expect(calls).toEqual(["ack", "delete", "ack", "delete"]);
    expect(await Bun.file(`${directory}/music_guild.json`).exists()).toBe(false);
  } finally {
    await music.stop();
  }
});
