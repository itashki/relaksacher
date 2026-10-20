/** @file Exercise admin commands and access enforcement through real Discord event routing. */
import { expect, onTestFinished, test } from "bun:test";
import { Events, type ClientUser, type Guild, type Message } from "discord.js";
import { createDiscordAccess } from "../src/adapters/discord-access.ts";
import { accessFeatures, createDiscordAccessStore } from "../src/adapters/discord-access-store.ts";
import { createDiscordBot, fixture } from "./fixtures.ts";
import { temporaryDirectory } from "./temp.ts";

/** Fake guild members can change roles and administrator status between requests. */
function guildFixture() {
  const admins = new Set(["1"]);
  const roles = new Map<string, string[]>();
  const guild = {
    id: "10",
    members: {
      fetch: async (id: string) => {
        if (id === "999") throw new Error("Unknown member");
        return {
          voice: { channel: null as null },
          permissions: { has: () => admins.has(id) },
          roles: { cache: new Map((roles.get(id) ?? []).map((role) => [role, {}])) },
        };
      },
    },
    roles: { fetch: async (id: string) => (id === "999" ? null : { id }) },
  } as unknown as Guild;
  const payloads: { content?: string; allowedMentions?: unknown }[] = [];
  const message = (content: string, userId = "1") =>
    ({
      id: crypto.randomUUID(),
      content,
      guild,
      guildId: "10",
      channelId: "channel",
      author: {
        id: userId,
        username: "User",
        bot: false,
        send: async () => {
          throw new Error("Settings must not use DMs");
        },
      },
      mentions: { has: () => true },
      channel: { id: "channel", isThread: () => true, ownerId: "bot" },
      reply: async (payload: { content?: string; allowedMentions?: unknown }) => {
        if (content.startsWith("!access") || content.startsWith("!доступ"))
          expect(payload.content).toContain("Нажмите кнопку");
        payloads.push(payload);
        return {};
      },
    }) as unknown as Message;
  async function configure(
    access: ReturnType<typeof createDiscordAccess>,
    content: string,
    userId = "1",
  ) {
    const request = message(content, userId);
    let customId: string;
    request.reply = async (payload: unknown) => {
      const launch = payload as {
        content: string;
        components: { components: { data: { custom_id: string } }[] }[];
      };
      expect(launch.content).toContain("Нажмите кнопку");
      customId = launch.components[0].components[0].data.custom_id;
      return fixture<Awaited<ReturnType<Message["reply"]>>>({});
    };
    await access.handle(request);
    await access.handleInteraction({
      guild,
      guildId: guild.id,
      user: { id: userId },
      customId,
      isButton: () => true,
      deferReply: async (payload: { flags: number }) => {
        expect(payload.flags).toBe(64);
      },
      editReply: async (payload: { content?: string; allowedMentions?: unknown }) => {
        payloads.push(payload);
      },
      followUp: async (payload: { content?: string; allowedMentions?: unknown; flags: number }) => {
        expect(payload.flags).toBe(64);
        payloads.push(payload);
      },
    } as unknown as Parameters<typeof access.handleInteraction>[0]);
  }
  return { guild, admins, roles, payloads, message, configure };
}

test("only administrators can inspect or change mixed role/user policies and reset one feature", async () => {
  const directory = await temporaryDirectory("discord-admin-access-");
  const access = createDiscordAccess(directory);
  const { configure, guild, payloads } = guildFixture();
  await configure(access, "!access model whitelist <@&20> <@30> user:31 role:21");
  const store = createDiscordAccessStore(directory);
  expect((await store.get("10")).model).toEqual({
    mode: "whitelist",
    roles: ["20", "21"],
    users: ["30", "31"],
  });
  expect(await access.denial(guild, "30", "model")).toBeNull();
  expect(await access.denial(guild, "40", "model")).toContain("ограничен");
  expect(await access.denial(guild, "1", "model")).toBeNull();
  expect(await access.denial(null, "40", "model")).toBeNull();
  await configure(access, "!access model reset", "40");
  expect(payloads.at(-1).content).toContain("только администратор");
  expect(await access.denial(guild, "40", "model")).toContain("ограничен");
  await configure(access, "!access", "40");
  expect(payloads.at(-1).content).toContain("только администратор");
  await configure(access, "!доступ");
  expect(payloads.some((p) => p.content?.includes("Настройки доступа"))).toBe(true);
  expect(
    payloads.every(
      (p) =>
        !p.allowedMentions ||
        JSON.stringify(p.allowedMentions) === JSON.stringify({ parse: [], repliedUser: false }),
    ),
  ).toBe(true);
  await configure(access, "!access model reset");
  expect(await access.denial(guild, "40", "model")).toBeNull();
});

test("invalid roles, users and modes leave policy intact; latest roles are used", async () => {
  const directory = await temporaryDirectory("discord-access-validation-");
  const access = createDiscordAccess(directory);
  const { configure, guild, roles, payloads } = guildFixture();
  await configure(access, "!access music whitelist <@&20>");
  for (const args of [
    "blacklist <@&999>",
    "blacklist <@999>",
    "blacklist nonsense",
    "reset <@30>",
    "unknown",
  ]) {
    await configure(access, `!access music ${args}`);
    expect(payloads.at(-1).content).not.toContain("сохранены");
    expect(await access.denial(guild, "40", "music")).toContain("ограничен");
  }
  roles.set("40", ["20"]);
  expect(await access.denial(guild, "40", "music")).toBeNull();
  roles.set("40", []);
  expect(await access.denial(guild, "40", "music")).toContain("ограничен");
  expect(await access.denial(guild, "40", "voice")).toBeNull();
});

test("message commands enforce every feature before fetching speech sources or invoking the model", async () => {
  const directory = await temporaryDirectory("discord-access-routing-");
  const store = createDiscordAccessStore(directory);
  for (const feature of accessFeatures)
    await store.set("10", feature, { mode: "blacklist", roles: [], users: ["40"] });
  let modelCalls = 0,
    voiceCalls = 0,
    references = 0,
    observations = 0;
  const bot = createDiscordBot({
    memoryDirectory: directory,
    config: {},
    assistant: {
      createSession() {
        modelCalls++;
        return { stop() {}, async run() {} };
      },
      observeMessage() {
        observations++;
      },
      considerMessage() {
        observations++;
      },
    },
    generateVoice: async () => {
      voiceCalls++;
      throw new Error("must not synthesize");
    },
  });
  onTestFinished(() => bot.stop());
  bot.client.user = fixture<ClientUser>({ id: "bot" });
  const { message, payloads } = guildFixture();
  for (const content of [
    "!voice",
    "!голос текст",
    "!tts",
    "!озвучь стоп",
    "!music",
    "!музыка играть",
    "<@bot> question",
  ]) {
    const input = message(content, "40");
    if (/^!(?:voice|tts)$/.test(content)) {
      input.reference = fixture<Message["reference"]>({ messageId: "previous" });
      input.fetchReference = async () => {
        references++;
        throw new Error("must not read");
      };
    }
    await bot.client.listeners(Events.MessageCreate)[0](input);
    expect(payloads.at(-1).content).toContain("ограничен");
  }
  expect(modelCalls).toBe(0);
  expect(voiceCalls).toBe(0);
  expect(references).toBe(0);
  expect(observations).toBe(0);
  const before = payloads.length;
  const ordinary = message("ordinary conversation", "40");
  ordinary.mentions.has = () => false;
  ordinary.channel.isThread = (() => false) as typeof ordinary.channel.isThread;
  await bot.client.listeners(Events.MessageCreate)[0](ordinary);
  expect(payloads.length).toBe(before);
  expect(observations).toBe(0);
  const reply = message("reply to bot", "40");
  reply.mentions.has = () => false;
  reply.reference = fixture<Message["reference"]>({ messageId: "previous" });
  reply.fetchReference = async () =>
    fixture<Awaited<ReturnType<Message["fetchReference"]>>>({ author: { id: "bot" } });
  await bot.client.listeners(Events.MessageCreate)[0](reply);
  expect(payloads.at(-1).content).toContain("ограничен");
  expect(modelCalls).toBe(0);
  // Administrators retain model access, even with restrictive policies.
  await bot.client.listeners(Events.MessageCreate)[0](message("<@bot> question"));
  expect(modelCalls).toBe(1);
});

test("music buttons, selectors and modal submissions enforce access before opening or mutating controls", async () => {
  const directory = await temporaryDirectory("discord-access-interactions-");
  await createDiscordAccessStore(directory).set("10", "music", {
    mode: "whitelist",
    roles: [],
    users: [],
  });
  const bot = createDiscordBot({ memoryDirectory: directory, config: {}, assistant: {} });
  onTestFinished(() => bot.stop());
  const { guild } = guildFixture();
  for (const type of ["button", "select", "modal"]) {
    const responses: { content: string; flags: number }[] = [];
    await bot.client.listeners(Events.InteractionCreate)[0]({
      guild,
      guildId: guild.id,
      user: { id: "40" },
      customId: "music:add",
      isButton: () => type === "button",
      isStringSelectMenu: () => type === "select",
      isModalSubmit: () => type === "modal",
      reply: async (payload: { content: string; flags: number }) => {
        responses.push(payload);
      },
      showModal: () => {
        throw new Error("must not open");
      },
    });
    expect(responses[0].content).toContain("ограничен");
    expect(responses[0].flags).toBe(64);
  }
});

test("missing guild/member data and corrupt files fail closed for restricted features", async () => {
  const directory = await temporaryDirectory("discord-access-errors-");
  await createDiscordAccessStore(directory).set("10", "model", {
    mode: "whitelist",
    roles: [],
    users: ["40"],
  });
  const access = createDiscordAccess(directory);
  const { guild } = guildFixture();
  expect(await access.denial(guild, "999", "model")).toContain("Не удалось проверить");
  expect(await access.denial(null, "40", "model", "10")).toContain("Не удалось проверить");
  await Bun.write(`${directory}/access_10.json`, "invalid JSON");
  const fresh = createDiscordAccess(directory);
  expect(await fresh.denial(guild, "40", "model")).toContain("Не удалось проверить");
});

test("a forbidden TTS stop cannot discard another member's pending speech batch", async () => {
  const directory = await temporaryDirectory("discord-access-stop-");
  await createDiscordAccessStore(directory).set("10", "tts", {
    mode: "blacklist",
    roles: [],
    users: ["40"],
  });
  const bot = createDiscordBot({
    memoryDirectory: directory,
    config: { messageBatchWindowMs: 30 },
    assistant: {},
  });
  onTestFinished(() => bot.stop());
  bot.client.user = fixture<ClientUser>({ id: "bot" });
  const { message, payloads } = guildFixture();
  const delivery = bot.client.listeners(Events.MessageCreate)[0](message("!tts hello", "30"));
  await bot.client.listeners(Events.MessageCreate)[0](message("!tts stop", "40"));
  expect(payloads.at(-1).content).toContain("ограничен");
  await delivery;
  // Delivery still reaches TTS's own channel check after the pending batch expires.
  expect(payloads.at(-1).content).toContain("Сначала войдите");
});
