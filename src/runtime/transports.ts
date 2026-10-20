/** @file Persistent Discord gateway and Telegram poller spanning planned application restarts. */
import { Client, Events, GatewayIntentBits, MessageFlags } from "discord.js";
import { run } from "@grammyjs/runner";
import { createTelegramApi } from "../adapters/telegram/api.ts";
import type { AppConfig } from "../types.ts";
import type { RuntimeEvent, RuntimeTransports } from "./contracts.ts";

/** Refuse connection changes during a hot restart; the existing sessions must remain connected. */
export function validateRestartConfig(previous: AppConfig, next: AppConfig) {
  if (
    previous.token !== next.token ||
    previous.telegramToken !== next.telegramToken ||
    previous.adapters.join(",") !== next.adapters.join(",")
  )
    throw new Error("Для изменения токенов или списка адаптеров нужен полный запуск процесса.");
}

/** Open transports once and route cancellation buttons to the old runtime while it drains. */
export function createTransports(
  config: AppConfig,
  dispatch: (event: RuntimeEvent, cancellation: boolean) => Promise<void>,
) {
  const connections: RuntimeTransports = {};
  let runner: ReturnType<typeof run> | undefined;
  let closed = false;
  if (config.adapters.includes("discord")) {
    const client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.GuildVoiceStates,
        GatewayIntentBits.MessageContent,
      ],
    });
    connections.discord = client;
    client.once(Events.ClientReady, () => {
      client.user.setPresence({ status: "online" });
      console.log(`Logged in as ${client.user.tag}`);
    });
    client.on(Events.MessageCreate, (message) => {
      void dispatch({ kind: "discord-message", message }, false).catch(report);
    });
    client.on(Events.InteractionCreate, (interaction) => {
      const cancellation =
        interaction.isButton() && interaction.customId.startsWith("stop_generation:");
      void dispatch({ kind: "discord-interaction", interaction }, cancellation).catch(report);
    });
  }
  if (config.adapters.includes("telegram"))
    connections.telegram = createTelegramApi(config.telegramToken, fetch, {
      timeoutMs: config.telegramTimeoutMs,
    });
  function report(error: unknown) {
    console.error("Messenger event failed:", error);
  }
  return {
    connections,
    /** Start receiving events without tying startup completion to the poller's lifetime. */
    async start() {
      await connections.discord?.login(config.token);
      if (closed || !connections.telegram) return;
      const api = connections.telegram;
      const me = await api("getMe");
      if (closed) return;
      console.log(`Telegram logged in as @${me.username}`);
      runner = run(
        {
          handleUpdate: (update: import("@grammyjs/types").Update) =>
            dispatch(
              { kind: "telegram-update", update },
              Boolean(update.callback_query?.data?.startsWith("stop:")),
            ),
          api: { getUpdates: (payload, signal) => api("getUpdates", payload, signal) },
          errorHandler: report,
        },
        {
          runner: {
            fetch: { timeout: 30, allowed_updates: ["message", "callback_query"] },
            silent: true,
          },
        },
      );
      void runner.task()?.catch(report);
    },
    async stop() {
      closed = true;
      await Promise.all([runner?.stop(), connections.discord?.destroy()]);
    },
  };
}

/** Acknowledge controls during replacement rather than letting Discord/Telegram time them out. */
export async function rejectRestartControl(event: RuntimeEvent, connections: RuntimeTransports) {
  const text = "Бот перезапускается. Повторите действие после рестарта.";
  if (event.kind === "discord-interaction" && event.interaction.isRepliable())
    await event.interaction.reply({ content: text, flags: MessageFlags.Ephemeral });
  else if (event.kind === "telegram-update" && event.update.callback_query)
    await connections.telegram?.("answerCallbackQuery", {
      callback_query_id: event.update.callback_query.id,
      text,
    });
}
