/** @file Consistent dismissal and parent navigation buttons shared by Discord menus. */
import { ActionRowBuilder, ButtonBuilder, ButtonStyle } from "discord.js";

/** Build an emoji-only close control; the caller owns authorization and dismissal behavior. */
export function closeButton(customId: string): ButtonBuilder {
  return new ButtonBuilder().setCustomId(customId).setEmoji("❌").setStyle(ButtonStyle.Secondary);
}

/** Build the common parent navigation control without changing the destination action. */
export function backButton(customId: string): ButtonBuilder {
  return new ButtonBuilder().setCustomId(customId).setLabel("←").setStyle(ButtonStyle.Secondary);
}

/** Build a cancellation control bound to one Discord generation. */
export function buildStopRow(generationId: string) {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`stop_generation:${generationId}`)
      .setLabel("Остановить генерацию")
      .setEmoji("⏹️")
      .setStyle(ButtonStyle.Secondary),
  );
}
