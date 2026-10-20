/** @file Message-shaped contracts shared by music commands and interactions. */
import {
  type Guild,
  type User,
  ActionRowBuilder,
  ButtonBuilder,
  StringSelectMenuBuilder,
  AttachmentBuilder,
} from "discord.js";

/** A text message or interaction forwarded through the same music authorization and queue boundary. */
export type MusicRequest = {
  /** Omit routine success replies for playback buttons; errors remain visible. */
  silentSuccess?: boolean;
  /** Render private player controls without replacing the shared guild panel. */
  transientPanel?: boolean;
  /** Bind an edit to a saved playlist ID independently of the server's active selection. */
  targetPlaylistId?: string;
  attachments?: { values(): IterableIterator<{ url: string; size: number }> };
  expectedPlaylistId?: string;
  expectedTracks?: string[];
  content: string;
  guild: Guild | null;
  author: Pick<User, "id">;
  reply: (payload: {
    content: string;
    files?: AttachmentBuilder[];
    components?: (ActionRowBuilder<ButtonBuilder> | ActionRowBuilder<StringSelectMenuBuilder>)[];
    allowedMentions: { parse: never[]; repliedUser: boolean };
  }) => Promise<unknown>;
};
