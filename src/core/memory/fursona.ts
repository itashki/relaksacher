/** @file Persist the assistant's character separately from participant facts, isolated per chat. */
import { rename } from "node:fs/promises";
import { resolvePath } from "../paths.ts";

export const MAX_FURSONA_LENGTH = 2000;

/** Create atomic character storage; chat identifiers come only from trusted adapters. */
export function createFursonaStore(directory: string) {
  const locks = new Map<string, Promise<unknown>>();

  function path(chatId: string) {
    if (typeof chatId !== "string" || !chatId.trim() || chatId.length > 300)
      throw new Error("Invalid fursona chat id");
    const key = new Bun.CryptoHasher("sha256").update(chatId).digest("hex");
    return resolvePath(`fursonas/${key}.json`, directory);
  }

  /** Load the current chat's character; missing storage means no character has been chosen yet. */
  async function loadFursona(chatId: string): Promise<string | null> {
    try {
      const data = await Bun.file(path(chatId)).json();
      if (typeof data.profile !== "string" || !data.profile.trim() || data.profile.length > MAX_FURSONA_LENGTH)
        throw new Error("Invalid saved fursona");
      return data.profile;
    } catch (error) {
      if (error.code === "ENOENT") return null;
      throw error;
    }
  }

  /**
   * Save a complete character profile and return the authoritative saved value.
   * Existing characters survive competing first saves; replace explicitly to update them.
   * Reject invalid input and surface I/O errors instead of claiming a successful save.
   */
  function saveFursona(chatId: string, profile: unknown, replace = false): Promise<string> {
    const file = path(chatId);
    if (typeof profile !== "string" || !profile.trim() || profile.trim().length > MAX_FURSONA_LENGTH)
      throw new Error(`Fursona must contain 1–${MAX_FURSONA_LENGTH} characters`);
    const normalized = profile.trim();
    const previous = locks.get(chatId) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(async () => {
      const existing = await loadFursona(chatId);
      if (existing !== null && !replace) return existing;
      const temporary = `${file}.tmp`;
      await Bun.write(temporary, JSON.stringify({ profile: normalized }, null, 2));
      await rename(temporary, file);
      return normalized;
    });
    locks.set(chatId, next);
    next.finally(() => {
      if (locks.get(chatId) === next) locks.delete(chatId);
    }).catch(() => {});
    return next;
  }

  return { loadFursona, saveFursona };
}
