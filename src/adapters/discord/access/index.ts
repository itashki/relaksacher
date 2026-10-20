/** @file Administer role and user policies and enforce Discord feature access before any work starts. */
import {
  MessageFlags,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  PermissionFlagsBits,
  type Guild,
  type Message,
  type Interaction,
} from "discord.js";
import { createDiscordAccessMenu } from "./menu.ts";
import { splitMessage } from "../message.ts";
import {
  accessFeatures,
  allowsFeature,
  createDiscordAccessStore,
  isAccessFeature,
  type AccessFeature,
} from "./store.ts";

const labels: Record<AccessFeature, string> = {
  model: "модель",
  voice: "голосовые сообщения",
  tts: "TTS",
  music: "управление музыкой",
};
const help = [
  "**Доступ по ролям и пользователям** (только администраторы)",
  "`!access` / `!доступ` — показать настройки",
  "`!access <функция> whitelist [@роль @пользователь …]` — разрешить только указанным ролям и пользователям",
  "`!access <функция> blacklist [@роль @пользователь …]` — запретить указанным ролям и пользователям",
  "`!access <функция> reset` — разрешить всем",
  "Нажмите кнопку под командой: настройки и ответы видны только вам.",
  "Функции: `model`, `voice`, `tts`, `music`.",
  "Для ID используйте `role:ID` или `user:ID` (ID без префикса — роль). Команда заменяет весь список функции; пустой whitelist запрещает всем, пустой blacklist разрешает всем. Совпадение любой роли или пользователя учитывается. Администраторы сохраняют доступ.",
].join("\n");

/** Recognize settings commands so batching never delays them. */
export function isAccessCommand(content: string): boolean {
  return /^\s*!(?:access|доступ)(?:\s|$)/iu.test(content);
}

/** Create the Discord policy boundary. Guild members are fetched for restricted operations,
 * so permissions and roles are checked at use time. Errors deny access instead of ignoring rules. */
export function createDiscordAccess(directory?: string) {
  const store = createDiscordAccessStore(directory);
  const menu = createDiscordAccessMenu(store);
  const requests = new Map<
    string,
    { userId: string; guildId: string | null; args: string[]; expires: number }
  >();
  /** Apply an administrator request through the caller's private response transport. */
  async function configure(
    guild: Guild | null,
    userId: string,
    args: string[],
    reply: (content: string) => Promise<unknown>,
  ) {
    try {
      if (!guild) throw new Error("Настройки доступа доступны только на Discord-сервере.");
      const member = await guild.members.fetch(userId);
      if (!member.permissions.has(PermissionFlagsBits.Administrator))
        throw new Error(
          "Настройки доступа может менять и просматривать только администратор сервера.",
        );
      if (!args.length || args[0] === "help") {
        const rules = await store.get(guild.id);
        const lines = accessFeatures.map((feature) => {
          const rule = rules[feature];
          return `**${feature}**: ${rule ? `${rule.mode} — ${[...rule.roles.map((id) => `<@&${id}>`), ...rule.users.map((id) => `<@${id}>`)].join(", ") || "пустой список"}` : "доступно всем"}`;
        });
        await reply(help);
        for (const page of splitMessage(lines.join("\n"), 1900)) await reply(page);
        return;
      }
      const [feature, mode, ...values] = args;
      if (!isAccessFeature(feature) || !["whitelist", "blacklist", "reset"].includes(mode))
        throw new Error(help);
      if (mode === "reset") {
        if (values.length)
          throw new Error("После reset не нужно указывать роли или пользователей.");
        await store.set(guild.id, feature);
      } else {
        if (values.length > 100)
          throw new Error("В списке может быть не более 100 ролей и пользователей суммарно.");
        const roles: string[] = [];
        const users: string[] = [];
        for (const value of new Set(values)) {
          const role = value.match(/^(?:<@&(\d{1,20})>|(?:role:)?(\d{1,20}))$/);
          const user = value.match(/^(?:<@!?(\d{1,20})>|user:(\d{1,20}))$/);
          if (role) roles.push(role[1] ?? role[2]);
          else if (user) users.push(user[1] ?? user[2]);
          else throw new Error("Укажите @роль, @пользователя, role:ID или user:ID через пробелы.");
        }
        for (const id of new Set(roles))
          if (!(await guild.roles.fetch(id)))
            throw new Error(`Роль ${id} не найдена на этом сервере.`);
        for (const id of new Set(users)) await guild.members.fetch(id);
        await store.set(guild.id, feature, {
          mode: mode as "whitelist" | "blacklist",
          roles,
          users,
        });
      }
      await reply(
        `Настройки «${labels[feature]}» сохранены: ${mode === "reset" ? "доступно всем" : `${mode}, записей: ${new Set(values).size}`}.`,
      );
    } catch (error) {
      await reply(
        error instanceof Error ? error.message : "Не удалось сохранить настройки доступа.",
      ).catch((failure: unknown) =>
        console.error("Failed to deliver private access response:", failure),
      );
    }
  }
  return {
    /** Return an actionable denial, or null when allowed. DMs have no guild role restrictions. */
    async denial(
      guild: Guild | null,
      userId: string,
      feature: AccessFeature,
      guildId?: string | null,
    ): Promise<string | null> {
      const id = guild?.id ?? guildId;
      if (!id) return null;
      try {
        const rule = (await store.get(id))[feature];
        if (!rule) return null;
        if (!guild) throw new Error("Guild is unavailable for access verification");
        const member = await guild.members.fetch(userId);
        return allowsFeature(
          rule,
          member.roles.cache.keys(),
          guild.id,
          userId,
          member.permissions.has(PermissionFlagsBits.Administrator),
        )
          ? null
          : `Доступ к функции «${labels[feature]}» ограничен администратором сервера.`;
      } catch (error) {
        console.error("Failed to check Discord access:", error);
        return "Не удалось проверить настройки доступа. Обратитесь к администратору сервера.";
      }
    },
    /** Text commands expose only a launcher; policies and outcomes are delivered after its click. */
    async handle(message: Message): Promise<boolean> {
      if (!isAccessCommand(message.content ?? "")) return false;
      const [, ...args] = message.content.trim().split(/\s+/u);
      for (const [id, request] of requests) if (request.expires <= Date.now()) requests.delete(id);
      while (requests.size >= 500) requests.delete(requests.keys().next().value!);
      const token = crypto.randomUUID();
      requests.set(token, {
        userId: message.author.id,
        guildId: message.guildId ?? message.guild?.id ?? null,
        args,
        expires: Date.now() + 300_000,
      });
      try {
        await message.reply({
          content: "Нажмите кнопку, чтобы открыть настройки доступа. Ответ будет виден только вам.",
          components: [
            new ActionRowBuilder<ButtonBuilder>().addComponents(
              new ButtonBuilder()
                .setCustomId(`access:open:${token}`)
                .setLabel("Открыть настройки")
                .setStyle(ButtonStyle.Primary),
            ),
          ],
          allowedMentions: { parse: [] as never[], repliedUser: false },
        });
      } catch (error) {
        requests.delete(token);
        throw error;
      }
      return true;
    },
    /** Bind private responses to the caller, then recheck administrator permissions at execution. */
    async handleInteraction(interaction: Interaction): Promise<boolean> {
      if (await menu.handle(interaction)) return true;
      if (!interaction.isButton() || !interaction.customId.startsWith("access:open:")) return false;
      const token = interaction.customId.slice("access:open:".length);
      const request = requests.get(token);
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      if (!request || request.expires <= Date.now()) {
        requests.delete(token);
        await interaction.editReply({ content: "Эта кнопка устарела. Вызовите !access ещё раз." });
        return true;
      }
      if (
        request.userId !== interaction.user.id ||
        request.guildId !== (interaction.guildId ?? interaction.guild?.id ?? null)
      ) {
        await interaction.editReply({
          content: "Открыть настройки может только автор команды. Используйте !access.",
        });
        return true;
      }
      requests.delete(token);
      await interaction.message.delete().catch((error: unknown) => {
        console.warn("Failed to remove access settings launcher:", error);
      });
      if (!request.args.length || request.args[0] === "help") {
        await menu.open(interaction);
        return true;
      }
      let first = true;
      await configure(interaction.guild, interaction.user.id, request.args, async (content) => {
        const payload = { content, allowedMentions: { parse: [] as never[], repliedUser: false } };
        if (first) {
          await interaction.editReply(payload);
          first = false;
        } else await interaction.followUp({ ...payload, flags: MessageFlags.Ephemeral });
      });
      return true;
    },
    close: store.close,
  };
}
