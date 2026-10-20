/** @file Exercise private settings navigation, owner checks and explicit save through Discord events. */
import { expect, onTestFinished, test } from "bun:test";
import { Events, type ClientUser } from "discord.js";
import { createDiscordAccessStore } from "../../src/adapters/discord/access/store.ts";
import { createDiscordBot, fixture } from "../support/fixtures.ts";
import { temporaryDirectory } from "../support/temp.ts";

type Payload = {
  content: string;
  flags?: number;
  components?: {
    components: { data: { custom_id?: string; type?: number; max_values?: number } }[];
  }[];
};

/** Model component events without allowing private settings to use a public reply or a DM. */
async function menuFixture() {
  const directory = await temporaryDirectory("discord-access-menu-");
  let admin = true;
  const guild = {
    id: "10",
    members: {
      fetch: async (id: string) => {
        if (id === "999") throw new Error("Unknown member");
        return { permissions: { has: () => admin }, roles: { cache: new Map() } };
      },
    },
    roles: { fetch: async (id: string) => ({ id }) },
  };
  const bot = createDiscordBot({ memoryDirectory: directory, config: {}, assistant: {} });
  onTestFinished(() => bot.stop());
  bot.client.user = fixture<ClientUser>({ id: "bot" });
  const publicReplies: Payload[] = [];
  const privateReplies: Payload[] = [];
  const acknowledgements: number[] = [];
  await bot.client.listeners(Events.MessageCreate)[0]({
    content: "!access",
    author: {
      id: "1",
      send: () => {
        throw new Error("No DMs");
      },
    },
    guild,
    guildId: "10",
    reply: async (payload: Payload) => {
      publicReplies.push(payload);
    },
  });
  const launchId = publicReplies[0].components[0].components[0].data.custom_id;
  async function event(customId: string, kind = "button", values: string[] = [], userId = "1") {
    await bot.client.listeners(Events.InteractionCreate)[0]({
      customId,
      guild,
      guildId: "10",
      user: { id: userId },
      values,
      isButton: () => kind === "button",
      isStringSelectMenu: () => kind === "string",
      isRoleSelectMenu: () => kind === "role",
      isUserSelectMenu: () => kind === "user",
      deferReply: async ({ flags }: { flags: number }) => {
        acknowledgements.push(flags);
        expect(flags).toBe(64);
      },
      deferUpdate: async () => {},
      editReply: async (payload: Payload) => {
        privateReplies.push(payload);
      },
      reply: async (payload: Payload) => {
        expect(payload.flags).toBe(64);
        privateReplies.push(payload);
      },
      followUp: async (payload: Payload) => {
        expect(payload.flags).toBe(64);
        privateReplies.push(payload);
      },
    });
  }
  const latest = () => privateReplies.at(-1);
  const control = (action: string) =>
    latest()
      .components.flatMap((row) => row.components)
      .find((item) => item.data.custom_id?.endsWith(`:${action}`)).data.custom_id;
  return {
    directory,
    publicReplies,
    privateReplies,
    acknowledgements,
    launchId,
    event,
    control,
    latest,
    revokeAdmin: () => {
      admin = false;
    },
  };
}

test("menu configures mixed role/user lists without further text commands; edits require Save", async () => {
  const ui = await menuFixture();
  expect(ui.publicReplies).toHaveLength(1);
  expect(ui.publicReplies[0].content).not.toContain("whitelist");
  await ui.event(ui.launchId);
  expect(ui.latest().content).toContain("Выберите функцию");
  await ui.event(ui.control("feature"), "string", ["music"]);
  await ui.event(ui.control("mode"), "string", ["whitelist"]);
  await ui.event(ui.control("roles"), "role", ["20"]);
  await ui.event(ui.control("users"), "user", ["30"]);
  expect(await createDiscordAccessStore(ui.directory).get("10")).toEqual({});
  await ui.event(ui.control("save"));
  expect(ui.latest().content).toContain("сохранены");
  expect((await createDiscordAccessStore(ui.directory).get("10")).music).toEqual({
    mode: "whitelist",
    roles: ["20"],
    users: ["30"],
  });
  await ui.event(ui.control("mode"), "string", ["blacklist"]);
  await ui.event(ui.control("save"));
  expect((await createDiscordAccessStore(ui.directory).get("10")).music.mode).toBe("blacklist");
  await ui.event(ui.control("mode"), "string", ["all"]);
  await ui.event(ui.control("save"));
  expect((await createDiscordAccessStore(ui.directory).get("10")).music).toBeUndefined();
  expect(ui.publicReplies).toHaveLength(1);
  expect(ui.acknowledgements).toEqual([64]);
});

test("launcher and private menu reject other users without consuming the owner's request", async () => {
  const ui = await menuFixture();
  await ui.event(ui.launchId, "button", [], "2");
  expect(ui.latest().content).toContain("только автор");
  await ui.event(ui.launchId);
  const featureId = ui.control("feature");
  await ui.event(featureId, "string", ["model"], "2");
  expect(ui.latest().content).toContain("принадлежит автору");
  await ui.event(featureId, "string", ["model"]);
  await ui.event(ui.control("mode"), "string", ["whitelist"]);
  const saveId = ui.control("save");
  await ui.event(ui.control("close"));
  await ui.event(saveId);
  expect(ui.latest().content).toContain("устарело");
  expect(await createDiscordAccessStore(ui.directory).get("10")).toEqual({});
});

test("navigation discards unsaved edits and administrator rights are checked again before saving", async () => {
  const ui = await menuFixture();
  await ui.event(ui.launchId);
  await ui.event(ui.control("feature"), "string", ["tts"]);
  await ui.event(ui.control("mode"), "string", ["whitelist"]);
  await ui.event(ui.control("users"), "user", ["30"]);
  await ui.event(ui.control("back"));
  await ui.event(ui.control("feature"), "string", ["tts"]);
  expect(ui.latest().content).toContain("Доступно всем");
  await ui.event(ui.control("mode"), "string", ["blacklist"]);
  const saveId = ui.control("save");
  ui.revokeAdmin();
  await ui.event(saveId);
  expect(ui.latest().content).toContain("только администратору");
  expect(await createDiscordAccessStore(ui.directory).get("10")).toEqual({});
});

test("failed saves keep the previous policy and report the error only in the private menu", async () => {
  const ui = await menuFixture();
  await ui.event(ui.launchId);
  await ui.event(ui.control("feature"), "string", ["voice"]);
  await ui.event(ui.control("mode"), "string", ["whitelist"]);
  await ui.event(ui.control("users"), "user", ["30"]);
  await Bun.$`mkdir ${ui.directory + "/access_10.json.tmp"}`.quiet();
  await ui.event(ui.control("save"));
  expect(ui.latest().content).not.toContain("✅");
  expect(ui.latest().components).toEqual([]);
  expect(await createDiscordAccessStore(ui.directory).get("10")).toEqual({});
  expect(ui.publicReplies).toHaveLength(1);
});
