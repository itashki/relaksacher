/** @file Boundaries between persistent network connections and reloadable application handlers. */
import type { Client, Interaction, Message } from "discord.js";
import type { Update } from "@grammyjs/types";
import type { TelegramApi } from "../types.ts";

/** Existing messenger connections, reused rather than reauthenticated during a restart. */
export type RuntimeTransports = { discord?: Client; telegram?: TelegramApi };

/** Platform events retained by the host until a runtime can accept them. */
export type RuntimeEvent =
  | { kind: "discord-message"; message: Message }
  | { kind: "discord-interaction"; interaction: Interaction }
  | { kind: "telegram-update"; update: Update };

/** Fresh application module with every local dependency bundled into the same revision. */
export type ApplicationModule = typeof import("./application.ts");
