/** @file Discord gateway and Telegram poller owned by the application process. */
import { Client, Events, GatewayIntentBits } from "discord.js";
import { run } from "@grammyjs/runner";
import { TELEGRAM_UPDATES } from "../adapters/telegram/snake-leaderboard.ts";
import { createTelegramApi } from "../adapters/telegram/api.ts";
import type { AppConfig } from "../types.ts";
import type { RuntimeEvent, RuntimeTransports } from "./contracts.ts";

/** Open transports once and forward messenger events until shutdown. */
export function createTransports(
  config: AppConfig,
  dispatch: (event: RuntimeEvent) => Promise<void>,
) {
  const connections: RuntimeTransports = {};
  let runner: ReturnType<typeof run> | undefined;
  let closed = false;
  let detachDiscord = () => {};
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
    const onMessage = (message: import("discord.js").Message) => {
      void dispatch({ kind: "discord-message", message }).catch(report);
    };
    const onInteraction = (interaction: import("discord.js").Interaction) => {
      void dispatch({ kind: "discord-interaction", interaction }).catch(report);
    };
    client.on(Events.MessageCreate, onMessage);
    client.on(Events.InteractionCreate, onInteraction);
    detachDiscord = () => {
      client.off(Events.MessageCreate, onMessage);
      client.off(Events.InteractionCreate, onInteraction);
    };
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
            dispatch({ kind: "telegram-update", update }),
          api: { getUpdates: (payload, signal) => api("getUpdates", payload, signal) },
          errorHandler: report,
        },
        {
          runner: {
            fetch: { timeout: 30, allowed_updates: TELEGRAM_UPDATES },
            silent: true,
          },
        },
      );
      void runner.task()?.catch(report);
    },
    /** Stop admitting events while keeping the Discord gateway available for final replies. */
    async stopReceiving() {
      detachDiscord();
      await runner?.stop();
    },
    async stop() {
      closed = true;
      await Promise.all([runner?.stop(), connections.discord?.destroy()]);
    },
  };
}
