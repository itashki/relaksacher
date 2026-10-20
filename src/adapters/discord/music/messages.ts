/** @file Shared Discord music message controls, including dismissal independent of playback. */
import { closeButton, backButton } from "../controls.ts";
import { ActionRowBuilder, ButtonBuilder, type StringSelectMenuBuilder } from "discord.js";

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
      ...(back ? [backButton(back)] : []),
      closeButton("music:dismiss"),
    ),
  ];
}
