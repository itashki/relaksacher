/** @file Messenger connections and incoming events shared by the host and application. */
import type { Client, Interaction, Message } from "discord.js";
import type { Update } from "@grammyjs/types";
import type { TelegramApi } from "../types.ts";

/** Messenger connections owned by the process host. */
export type RuntimeTransports = { discord?: Client; telegram?: TelegramApi };

/** Platform events delivered to application handlers. */
export type RuntimeEvent =
  | { kind: "discord-message"; message: Message }
  | { kind: "discord-interaction"; interaction: Interaction }
  | { kind: "telegram-update"; update: Update };
