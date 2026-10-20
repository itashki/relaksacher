/** @file Shared Discord music message controls, including dismissal independent of playback. */
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  type StringSelectMenuBuilder,
} from "discord.js";

export type MusicMessageRow =
  ActionRowBuilder<ButtonBuilder> | ActionRowBuilder<StringSelectMenuBuilder>;

/** Append dismissal and optional parent navigation without mutating rows; views reserve one of five rows. */
export function musicMessageComponents(
  rows: MusicMessageRow[] = [],
  back?: string,
): MusicMessageRow[] {
  if (
    rows.some((row) =>
      row
        .toJSON()
        .components.some(
          (component) => "custom_id" in component && component.custom_id === "music:dismiss",
        ),
    ) &&
    !back
  )
    return rows;
  return [
    ...rows.filter(
      (row) =>
        !row
          .toJSON()
          .components.some(
            (component) => "custom_id" in component && component.custom_id === "music:dismiss",
          ),
    ),
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      ...(back
        ? [
            new ButtonBuilder()
              .setCustomId(back)
              .setLabel("← Назад")
              .setStyle(ButtonStyle.Secondary),
          ]
        : []),
      new ButtonBuilder()
        .setCustomId("music:dismiss")
        .setEmoji("❌")
        .setStyle(ButtonStyle.Secondary),
    ),
  ];
}
