/** @file Consistent dismissal and parent navigation buttons shared by Discord menus. */
import { ButtonBuilder, ButtonStyle } from "discord.js";

/** Build an emoji-only close control; the caller owns authorization and dismissal behavior. */
export function closeButton(customId: string): ButtonBuilder {
  return new ButtonBuilder().setCustomId(customId).setEmoji("❌").setStyle(ButtonStyle.Secondary);
}

/** Build the common parent navigation control without changing the destination action. */
export function backButton(customId: string): ButtonBuilder {
  return new ButtonBuilder().setCustomId(customId).setLabel("←").setStyle(ButtonStyle.Secondary);
}
