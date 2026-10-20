/** @file Render and operate private, owner-bound Discord access settings menus. */
import { closeButton, backButton } from "../controls.ts";
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  MessageFlags,
  PermissionFlagsBits,
  RoleSelectMenuBuilder,
  StringSelectMenuBuilder,
  UserSelectMenuBuilder,
  type ButtonInteraction,
  type Interaction,
} from "discord.js";
import {
  accessFeatures,
  isAccessFeature,
  type AccessFeature,
  type AccessRule,
  type AccessSettings,
  type createDiscordAccessStore,
} from "./store.ts";

const labels: Record<AccessFeature, string> = {
  model: "Модель",
  voice: "Голосовые сообщения",
  tts: "Озвучка TTS",
  music: "Управление музыкой",
};
type Session = {
  userId: string;
  guildId: string;
  expires: number;
  feature?: AccessFeature;
  rule?: AccessRule;
  busy: boolean;
};
type Store = ReturnType<typeof createDiscordAccessStore>;
const mentions = { parse: [] as never[], repliedUser: false };

/** Keep draft edits private and isolated until Save; every action rechecks owner and administrator rights. */
export function createDiscordAccessMenu(store: Store) {
  const sessions = new Map<string, Session>();
  function render(token: string, session: Session, settings: AccessSettings, notice = "") {
    const id = (action: string) => `access:menu:${token}:${action}`;
    const feature = new StringSelectMenuBuilder()
      .setCustomId(id("feature"))
      .setPlaceholder("Выберите функцию")
      .addOptions(
        accessFeatures.map((value) => ({
          label: labels[value],
          value,
          default: session.feature === value,
        })),
      );
    const components: (
      | ActionRowBuilder<StringSelectMenuBuilder>
      | ActionRowBuilder<RoleSelectMenuBuilder>
      | ActionRowBuilder<UserSelectMenuBuilder>
      | ActionRowBuilder<ButtonBuilder>
    )[] = [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(feature)];
    let content =
      "**Настройки доступа**\nВыберите функцию. Изменения применяются кнопкой «Сохранить». «Назад» и смена функции отменяют несохранённые изменения.\n";
    if (session.feature) {
      const rule = session.rule;
      content += `\n**${labels[session.feature]}**\n${rule ? `${rule.mode === "whitelist" ? "Белый список: разрешить только выбранным" : "Чёрный список: запретить выбранным"}.\nРоли: ${rule.roles.map((role) => `<@&${role}>`).join(", ") || "нет"}\nПользователи: ${rule.users.map((user) => `<@${user}>`).join(", ") || "нет"}` : "Доступно всем"}.\n`;
      if (rule)
        content +=
          "Совпадение любой роли или пользователя учитывается. Пустой белый список запрещает всем; пустой чёрный разрешает всем.\n";
      const mode = new StringSelectMenuBuilder()
        .setCustomId(id("mode"))
        .setPlaceholder("Режим доступа")
        .addOptions([
          { label: "Доступно всем", value: "all", default: !rule },
          { label: "Белый список", value: "whitelist", default: rule?.mode === "whitelist" },
          { label: "Чёрный список", value: "blacklist", default: rule?.mode === "blacklist" },
        ]);
      components.push(new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(mode));
      if (rule) {
        components.push(
          new ActionRowBuilder<RoleSelectMenuBuilder>().addComponents(
            new RoleSelectMenuBuilder()
              .setCustomId(id("roles"))
              .setPlaceholder("Выберите роли (до 25)")
              .setMinValues(0)
              .setMaxValues(25)
              .setDefaultRoles(...rule.roles.slice(0, 25)),
          ),
        );
        components.push(
          new ActionRowBuilder<UserSelectMenuBuilder>().addComponents(
            new UserSelectMenuBuilder()
              .setCustomId(id("users"))
              .setPlaceholder("Выберите пользователей (до 25)")
              .setMinValues(0)
              .setMaxValues(25)
              .setDefaultUsers(...rule.users.slice(0, 25)),
          ),
        );
        if (rule.roles.length > 25 || rule.users.length > 25)
          content +=
            "При изменении поля его длинный список будет заменён выбранными в меню участниками (до 25).\n";
      }
    } else {
      content += accessFeatures
        .map(
          (value) =>
            `\n${labels[value]}: ${settings[value] ? (settings[value].mode === "whitelist" ? "белый список" : "чёрный список") : "доступно всем"}`,
        )
        .join("");
    }
    const buttons = new ActionRowBuilder<ButtonBuilder>();
    if (session.feature)
      buttons.addComponents(
        new ButtonBuilder()
          .setCustomId(id("save"))
          .setLabel("Сохранить")
          .setStyle(ButtonStyle.Success),
        backButton(id("back")),
      );
    buttons.addComponents(closeButton(id("close")));
    components.push(buttons);
    // Lists can contain legacy 100-entry policies; keep the Discord message within its limit.
    if (content.length > 1600)
      content = `**Настройки доступа: ${session.feature ? labels[session.feature] : "все функции"}**\nВ сохранённом списке ${session.rule?.roles.length ?? 0} ролей и ${session.rule?.users.length ?? 0} пользователей. При изменении поля его список заменяется выбранными значениями (до 25).`;
    return {
      content: `${content}\nАдминистраторы сохраняют доступ.\n${notice}`,
      components,
      allowedMentions: mentions,
    };
  }
  return {
    /** Open a private menu after the launch button has already received an ephemeral acknowledgement. */
    async open(interaction: ButtonInteraction) {
      try {
        if (!interaction.guild) throw new Error("Настройки доступны только на сервере.");
        const member = await interaction.guild.members.fetch(interaction.user.id);
        if (!member.permissions.has(PermissionFlagsBits.Administrator))
          throw new Error("Настройки доступны только администратору сервера.");
        const settings = await store.get(interaction.guild.id);
        for (const [key, value] of sessions) if (value.expires <= Date.now()) sessions.delete(key);
        while (sessions.size >= 500) sessions.delete(sessions.keys().next().value!);
        const token = crypto.randomUUID();
        const session: Session = {
          userId: interaction.user.id,
          guildId: interaction.guild.id,
          expires: Date.now() + 600_000,
          busy: false,
        };
        sessions.set(token, session);
        await interaction.editReply(render(token, session, settings));
      } catch (error) {
        await interaction.editReply({
          content: error instanceof Error ? error.message : "Не удалось открыть настройки.",
          components: [],
        });
      }
    },
    /** Operate existing ephemeral controls; saved rules never change on selection or navigation alone. */
    async handle(interaction: Interaction): Promise<boolean> {
      if (
        (!interaction.isButton() &&
          !interaction.isStringSelectMenu?.() &&
          !interaction.isRoleSelectMenu?.() &&
          !interaction.isUserSelectMenu?.()) ||
        !interaction.customId.startsWith("access:menu:")
      )
        return false;
      const [, , token, action] = interaction.customId.split(":");
      const session = sessions.get(token);
      const reject = (content: string) =>
        interaction.reply({ content, flags: MessageFlags.Ephemeral, allowedMentions: mentions });
      if (!session || session.expires <= Date.now()) {
        sessions.delete(token);
        await reject("Меню устарело. Вызовите !access ещё раз.");
        return true;
      }
      if (session.userId !== interaction.user.id || session.guildId !== interaction.guildId) {
        await reject("Это меню принадлежит автору команды. Используйте !access.");
        return true;
      }
      if (session.busy) {
        await reject("Дождитесь завершения предыдущего действия.");
        return true;
      }
      session.busy = true;
      try {
        await interaction.deferUpdate();
        if (action === "close") {
          sessions.delete(token);
          await interaction.deleteReply();
          return true;
        }
        if (
          !interaction.guild ||
          !(await interaction.guild.members.fetch(interaction.user.id)).permissions.has(
            PermissionFlagsBits.Administrator,
          )
        ) {
          sessions.delete(token);
          throw new Error("Настройки доступны только администратору сервера.");
        }
        session.expires = Date.now() + 600_000;
        let settings = await store.get(session.guildId);
        let notice = "";
        if (
          action === "feature" &&
          interaction.isStringSelectMenu() &&
          isAccessFeature(interaction.values[0])
        ) {
          session.feature = interaction.values[0];
          session.rule = structuredClone(settings[session.feature]);
        } else if (action === "back") {
          session.feature = undefined;
          session.rule = undefined;
        } else if (session.feature) {
          if (action === "mode" && interaction.isStringSelectMenu()) {
            const mode = interaction.values[0];
            if (mode === "all") session.rule = undefined;
            else if (mode === "whitelist" || mode === "blacklist")
              session.rule = {
                mode,
                roles: session.rule?.roles ?? [],
                users: session.rule?.users ?? [],
              };
          } else if (action === "roles" && interaction.isRoleSelectMenu() && session.rule)
            session.rule.roles = [...interaction.values];
          else if (action === "users" && interaction.isUserSelectMenu() && session.rule)
            session.rule.users = [...interaction.values];
          else if (action === "save") {
            for (const role of session.rule?.roles ?? [])
              if (!(await interaction.guild.roles.fetch(role)))
                throw new Error("Одна из выбранных ролей больше не существует.");
            for (const user of session.rule?.users ?? [])
              await interaction.guild.members.fetch(user);
            await store.set(session.guildId, session.feature, session.rule);
            settings = await store.get(session.guildId);
            notice = "✅ Настройки сохранены.";
          }
        }
        await interaction.editReply(render(token, session, settings, notice));
      } catch (error) {
        await interaction.editReply({
          content:
            error instanceof Error
              ? error.message
              : "Не удалось сохранить настройки. Повторите вызов !access.",
          components: [],
        });
      } finally {
        session.busy = false;
      }
      return true;
    },
  };
}
