/** @file Route music buttons, forms and selections with owner and snapshot validation. */
import { formatMusicTrack, type MusicMetadata } from "../../music/metadata.ts";
import { musicMessageComponents } from "./messages.ts";
import {
  type Interaction,
  ActionRowBuilder,
  ButtonBuilder,
  StringSelectMenuBuilder,
  ButtonStyle,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  MessageFlags,
} from "discord.js";
import type { MusicRuntime } from "./runtime.ts";
import type { MusicRequest } from "./request.ts";

/** Create component routing without duplicating the text-command mutation boundary. */
export function createMusicInteractionHandler(
  runtime: MusicRuntime,
  handle: (message: MusicRequest) => Promise<boolean>,
) {
  const {
    states,
    searchChoices,
    playlistMenus,
    removalMenus,
    listingMetadata,
    panels,
    refreshTimers,
    requireVoiceChannel,
  } = runtime;
  /** Check voice access before opening forms; route submissions through the shared command handler. */
  async function handleInteraction(interaction: Interaction): Promise<boolean> {
    if (
      (!interaction.isButton() &&
        !interaction.isModalSubmit() &&
        !interaction.isStringSelectMenu?.()) ||
      !interaction.customId.startsWith("music:")
    )
      return false;
    type ResponsePayload = Omit<Parameters<MusicRequest["reply"]>[0], "allowedMentions"> & {
      allowedMentions?: { parse: never[]; repliedUser: boolean };
      flags?: MessageFlags.Ephemeral;
    };
    const privateSource = Boolean(interaction.message?.flags?.has(MessageFlags.Ephemeral));
    let silentAction = false;
    let backAction: string | undefined = "music:back:panel";
    const controls = (payload: ResponsePayload) =>
      musicMessageComponents(payload.components, backAction);
    // A private screen is replaced in place, so button navigation cannot leave an old personal message behind.
    const deferResponse = () =>
      privateSource
        ? interaction.deferUpdate()
        : interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const respond = async (payload: ResponsePayload) => {
      if (privateSource) {
        await interaction.deferUpdate();
        return interaction.editReply({
          content: payload.content,
          files: payload.files,
          attachments: [],
          allowedMentions: payload.allowedMentions,
          components: controls(payload),
        });
      }
      return interaction.reply({ ...payload, components: controls(payload) });
    };
    const editResponse = (payload: Omit<ResponsePayload, "flags">) =>
      interaction.editReply({ ...payload, attachments: [], components: controls(payload) });
    const followUp = (payload: ResponsePayload) =>
      interaction.followUp({ ...payload, components: controls(payload) });
    try {
      if (interaction.isButton() && interaction.customId === "music:dismiss") {
        await interaction.deferUpdate();
        await interaction.deleteReply();
        const guildId = interaction.guild?.id;
        if (guildId && panels.get(guildId)?.id === interaction.message.id) {
          panels.delete(guildId);
          const timer = refreshTimers.get(guildId);
          if (timer) clearTimeout(timer);
          refreshTimers.delete(guildId);
        }
        return true;
      }
      if (!interaction.guild) {
        await respond({
          content: "Музыка доступна только на сервере.",
          flags: MessageFlags.Ephemeral,
        });
        return true;
      }
      if (
        interaction.isButton() &&
        !privateSource &&
        !interaction.customId.startsWith("music:back:") &&
        !interaction.customId.startsWith("music:pick:") &&
        !interaction.customId.startsWith("music:delete:") &&
        !interaction.customId.startsWith("music:playlist-") &&
        !interaction.customId.startsWith("music:library") &&
        !panels.has(interaction.guild.id) &&
        interaction.message?.id
      ) {
        panels.set(interaction.guild.id, interaction.message);
      }
      let action = interaction.customId.slice("music:".length);
      if (interaction.isButton() && action.startsWith("back:")) {
        const [, view, id] = action.split(":");
        if (
          !["panel", "playlists", "manage"].includes(view) ||
          (view === "manage" && (!id || !/^[\w-]{1,64}$/.test(id)))
        )
          throw new Error("Invalid navigation");
        backAction =
          view === "panel"
            ? undefined
            : view === "manage"
              ? "music:back:playlists"
              : "music:back:panel";
        await deferResponse();
        await handle({
          content:
            view === "panel"
              ? "!music panel"
              : view === "playlists"
                ? "!music playlists"
                : "!music playlist manage",
          targetPlaylistId: view === "manage" ? id : undefined,
          transientPanel: true,
          guild: interaction.guild,
          author: interaction.user,
          reply: async (payload) => {
            await editResponse(payload);
          },
        });
        return true;
      }

      if (action === "library" || action.startsWith("library-") || action.startsWith("playlist-")) {
        const [kind, token] = action.split(":");
        const operation = kind.startsWith("library-") ? kind.slice(8) : kind.slice(9);
        backAction =
          token && kind.startsWith("library-")
            ? `music:back:manage:${token}`
            : "music:back:playlists";
        if (interaction.isButton() && ["create", "rename", "add", "search"].includes(operation)) {
          try {
            await requireVoiceChannel(interaction.guild, interaction.user.id);
          } catch (error) {
            await respond({
              content:
                error instanceof Error ? error.message : "Не удалось проверить голосовой канал.",
              flags: MessageFlags.Ephemeral,
            });
            return true;
          }
          const input = new TextInputBuilder()
            .setCustomId("value")
            .setLabel(
              operation === "search"
                ? "Запрос (yt:, sc:, bc:, am:, ym:)"
                : operation === "add"
                  ? "Ссылка на трек или YouTube-плейлист"
                  : "Название плейлиста",
            )
            .setStyle(TextInputStyle.Short)
            .setRequired(true)
            .setMaxLength(operation === "search" ? 200 : operation === "add" ? 500 : 60);
          await interaction.showModal(
            new ModalBuilder()
              .setCustomId(`music:${action}`)
              .setTitle(
                operation === "create"
                  ? "Создать плейлист"
                  : operation === "rename"
                    ? "Переименовать плейлист"
                    : operation === "search"
                      ? "Поиск музыки"
                      : "Добавить треки",
              )
              .addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(input)),
          );
          return true;
        }
        let argument: string;
        if (["library", "library-manage"].includes(action) && interaction.isStringSelectMenu()) {
          const id = interaction.values[0] ?? "";
          if (!/^[\w-]{1,64}$/.test(id)) throw new Error("Invalid playlist selection");
          await deferResponse();
          backAction = "music:back:playlists";
          await handle({
            content: "!music playlist manage",
            targetPlaylistId: id,
            guild: interaction.guild,
            author: interaction.user,
            reply: async (payload) => {
              await editResponse(payload);
            },
          });
          return true;
        } else if (
          interaction.isModalSubmit() &&
          ["create", "rename", "delete", "add", "search"].includes(operation)
        ) {
          argument = `${operation} ${interaction.fields.getTextInputValue("value").trim()}`;
        } else if (interaction.isButton() && ["confirm", "cancel"].includes(operation) && token) {
          argument = `${operation} ${token}`;
        } else if (interaction.isButton() && operation === "activate" && token) {
          argument = `select ${token}`;
        } else if (interaction.isButton() && operation === "export") {
          argument = "export";
        } else if (interaction.isButton() && operation === "delete") {
          argument = "delete";
        } else throw new Error("Invalid playlist action");
        await deferResponse();
        await handle({
          content: `!music playlist ${argument}`,
          guild: interaction.guild,
          author: interaction.user,
          targetPlaylistId:
            kind.startsWith("library-") && operation !== "create" ? token : undefined,
          reply: async (payload) => {
            await editResponse(payload);
          },
        });
        return true;
      }
      if (interaction.isStringSelectMenu?.() && action.startsWith("jump:")) {
        const [, token, offsetText] = action.split(":");
        const menu = playlistMenus.get(token ?? "");
        const value = interaction.values[0] ?? "";
        const index = Number(value),
          offset = Number(offsetText);
        if (
          !menu ||
          menu.userId !== interaction.user.id ||
          menu.guildId !== interaction.guild.id ||
          menu.expires <= Date.now()
        ) {
          await respond({
            content: "Этот плейлист недоступен. Откройте свой плейлист заново.",
            flags: MessageFlags.Ephemeral,
          });
          return true;
        }
        if (
          !/^\d+$/.test(value) ||
          !Number.isInteger(offset) ||
          offset < 0 ||
          offset % 25 !== 0 ||
          index < offset ||
          index >= Math.min(offset + 25, menu.tracks.length)
        ) {
          await respond({
            content: "Некорректный выбор трека.",
            flags: MessageFlags.Ephemeral,
          });
          return true;
        }
        await deferResponse();
        await handle({
          content: `!music jump ${index + 1}`,
          guild: interaction.guild,
          author: interaction.user,
          expectedTracks: menu.tracks,
          expectedPlaylistId: menu.playlistId,
          reply: async (payload) => {
            await editResponse(payload);
          },
        });
        return true;
      }
      if ((interaction.isButton() && action === "remove") || action.startsWith("delete:")) {
        try {
          await requireVoiceChannel(interaction.guild, interaction.user.id);
        } catch (error) {
          await respond({
            content:
              error instanceof Error ? error.message : "Не удалось проверить голосовой канал.",
            flags: MessageFlags.Ephemeral,
          });
          return true;
        }
        const [, token, pageText = "0"] = action.split(":");
        let menu = token ? removalMenus.get(token) : undefined;
        if (
          token &&
          (!menu ||
            menu.userId !== interaction.user.id ||
            menu.guildId !== interaction.guild.id ||
            menu.expires <= Date.now())
        ) {
          await respond({
            content: "Список удаления недоступен. Откройте его заново.",
            flags: MessageFlags.Ephemeral,
          });
          return true;
        }
        if (token && (interaction.isButton() || interaction.isStringSelectMenu()))
          await interaction.deferUpdate();
        else await deferResponse();
        if (!states.has(interaction.guild.id))
          await handle({
            content: "!music list",
            guild: interaction.guild,
            author: interaction.user,
            reply: async () => {},
          });
        const tracks = states.get(interaction.guild.id)?.tracks ?? [];
        if (!menu) {
          menu = {
            userId: interaction.user.id,
            guildId: interaction.guild.id,
            playlistId: states.get(interaction.guild.id)!.library.activeId,
            tracks: [...tracks],
            expires: Date.now() + 300_000,
          };
        }
        if (
          menu.playlistId !== states.get(interaction.guild.id)!.library.activeId ||
          menu.tracks.length !== tracks.length ||
          menu.tracks.some((url, i) => url !== tracks[i])
        ) {
          await editResponse({ content: "Плейлист изменился. Откройте удаление заново." });
          return true;
        }
        if (interaction.isStringSelectMenu?.()) {
          const value = interaction.values[0] ?? "";
          const index = Number(value);
          const page = Number(pageText);
          if (
            !/^\d+$/.test(value) ||
            !Number.isInteger(page) ||
            index < page * 25 ||
            index >= Math.min(menu.tracks.length, (page + 1) * 25)
          ) {
            await editResponse({ content: "Некорректный выбор трека." });
            return true;
          }
          await handle({
            content: `!music remove ${index + 1}`,
            guild: interaction.guild,
            author: interaction.user,
            expectedTracks: menu.tracks,
            expectedPlaylistId: menu.playlistId,
            reply: async (payload) => {
              await editResponse(payload);
            },
          });
          return true;
        }
        if (!tracks.length) {
          await editResponse({ content: "Плейлист пуст." });
          return true;
        }
        const page = Number(pageText);
        if (!Number.isInteger(page) || page < 0 || page * 25 >= menu.tracks.length) {
          await editResponse({ content: "Такой страницы нет." });
          return true;
        }
        for (const [key, value] of removalMenus)
          if (value.expires <= Date.now()) removalMenus.delete(key);
        while (removalMenus.size >= 100) removalMenus.delete(removalMenus.keys().next().value!);
        const menuToken = token ?? crypto.randomUUID();
        removalMenus.set(menuToken, menu);
        const slice = menu.tracks.slice(page * 25, (page + 1) * 25);
        const metadata = new Map<string, MusicMetadata | null>();
        let cursor = 0;
        await Promise.all(
          Array.from({ length: Math.min(3, slice.length) }, async () => {
            while (cursor < slice.length) {
              const url = slice[cursor++];
              metadata.set(url, await listingMetadata(url));
            }
          }),
        );
        const select = new StringSelectMenuBuilder()
          .setCustomId(`music:delete:${menuToken}:${page}`)
          .setPlaceholder("Выберите трек для удаления")
          .addOptions(
            slice.map((url, i) => {
              const info = metadata.get(url);
              return {
                label: `${page * 25 + i + 1}. ${info?.title ?? url}`.slice(0, 100),
                value: String(page * 25 + i),
                description: formatMusicTrack(url, info ?? null)
                  .split(" · ")
                  .at(-1)!
                  .slice(0, 100),
              };
            }),
          );
        await editResponse({
          content: `Удаление треков · страница ${page + 1}/${Math.ceil(menu.tracks.length / 25)}`,
          components: [
            new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select),
            new ActionRowBuilder<ButtonBuilder>().addComponents(
              new ButtonBuilder()
                .setCustomId(`music:delete:${menuToken}:${page - 1}`)
                .setLabel("←")
                .setStyle(ButtonStyle.Secondary)
                .setDisabled(page === 0),
              new ButtonBuilder()
                .setCustomId(`music:delete:${menuToken}:${page + 1}`)
                .setLabel("→")
                .setStyle(ButtonStyle.Secondary)
                .setDisabled((page + 1) * 25 >= menu.tracks.length),
            ),
          ],
        });
        return true;
      }
      let selectedUrl = "";
      let selectedPlaylistId: string | undefined;
      let selectedDestinationId: string | undefined;
      if (interaction.isStringSelectMenu?.() && action.startsWith("pick:")) {
        const choice = searchChoices.get(action.slice(5));
        if (
          !choice ||
          choice.expires <= Date.now() ||
          choice.userId !== interaction.user.id ||
          choice.guildId !== interaction.guild.id
        ) {
          await respond({
            content: "Этот результат недоступен. Выполните свой поиск заново.",
            flags: MessageFlags.Ephemeral,
          });
          return true;
        }
        const value = interaction.values[0] ?? "";
        if (!/^\d+$/.test(value) || !choice.urls[Number(value)]) {
          await respond({
            content: "Некорректный выбор трека.",
            flags: MessageFlags.Ephemeral,
          });
          return true;
        }
        selectedUrl = choice.urls[Number(value)];
        if (choice.targeted) {
          selectedDestinationId = choice.playlistId;
          backAction = `music:back:manage:${choice.playlistId}`;
        } else selectedPlaylistId = choice.playlistId;
        action = "add";
      }
      if (interaction.isButton() && !selectedUrl && ["add", "remove", "search"].includes(action)) {
        try {
          await requireVoiceChannel(interaction.guild, interaction.user.id);
        } catch (error) {
          await respond({
            content:
              error instanceof Error ? error.message : "Не удалось проверить голосовой канал.",
            flags: MessageFlags.Ephemeral,
          });
          return true;
        }
        const input = new TextInputBuilder()
          .setCustomId("value")
          .setLabel(
            action === "search"
              ? "Запрос (yt:, sc:, bc:, am:, ym:)"
              : action === "add"
                ? "Ссылка на трек или YouTube-плейлист"
                : "Номер трека из плейлиста",
          )
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setMaxLength(action === "search" ? 200 : action === "add" ? 500 : 3)
          .setPlaceholder(
            action === "search"
              ? "Исполнитель — название"
              : action === "add"
                ? "https://www.youtube.com/playlist?list=…"
                : "Например: 3",
          );
        await interaction.showModal(
          new ModalBuilder()
            .setCustomId(`music:${action}`)
            .setTitle(
              action === "search"
                ? "Поиск музыки"
                : action === "add"
                  ? "Добавить музыку"
                  : "Удалить трек",
            )
            .addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(input)),
        );
        return true;
      }
      if (
        ![
          "search",
          "play",
          "toggle",
          "skip",
          "stop",
          "list",
          "add",
          "remove",
          "repeat",
          "shuffle",
          "mix",
          "queue",
          "playlists",
        ].includes(action) ||
        (interaction.isModalSubmit() && !["add", "remove", "search"].includes(action))
      ) {
        await respond({
          content: "Неизвестное действие. Откройте !music заново.",
          flags: MessageFlags.Ephemeral,
        });
        return true;
      }
      // Acknowledge before waiting on the per-guild command queue or network calls.
      silentAction =
        interaction.isButton() &&
        ["play", "toggle", "skip", "stop", "repeat", "shuffle", "mix"].includes(action);
      if (silentAction) await interaction.deferUpdate();
      else await deferResponse();
      const argument = interaction.isModalSubmit()
        ? interaction.fields.getTextInputValue("value").trim()
        : selectedUrl;
      let first = true;
      await handle({
        content: `!music ${action}${argument ? ` ${argument}` : ""}`,
        guild: interaction.guild,
        author: interaction.user,
        silentSuccess: silentAction,
        expectedPlaylistId: selectedPlaylistId,
        targetPlaylistId: selectedDestinationId,
        reply: async (payload) => {
          if (silentAction) {
            await followUp({ ...payload, flags: MessageFlags.Ephemeral });
          } else if (first || !["list", "queue"].includes(action)) {
            first = false;
            await editResponse(payload);
          } else await followUp({ ...payload, flags: MessageFlags.Ephemeral });
        },
      });
    } catch {
      const payload = {
        content: "Не удалось выполнить действие. Откройте !music и попробуйте снова.",
        flags: MessageFlags.Ephemeral as const,
      };
      if (!silentAction && privateSource && (interaction.deferred || interaction.replied))
        await editResponse({ content: payload.content }).catch(() => {});
      else if (interaction.deferred || interaction.replied) await followUp(payload).catch(() => {});
      else await respond(payload).catch(() => {});
    }
    return true;
  }
  return handleInteraction;
}
