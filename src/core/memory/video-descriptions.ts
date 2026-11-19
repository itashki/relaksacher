/** @file Persist per-chat video descriptions as JSON files with serialized atomic updates. */
import { replaceFileAtomically } from "../atomic-file.ts";
import { resolvePath } from "../paths.ts";

/** Stored description of one video, video note or animation message. */
export type VideoDescription = {
  messageId: string;
  fileUniqueId?: string;
  kind: "video_note" | "video" | "animation";
  author: string;
  /** ISO timestamp of the original message. */
  at: string;
  durationSec?: number;
  description: string;
  model: string;
};

const MAX_ENTRIES = 100; // при переполнении самые старые записи удаляются
const MAX_DESCRIPTION_LENGTH = 2000;

/**
 * Create file-backed video-description storage, one JSON file per chat.
 * Chat ids are sanitized to `[A-Za-z0-9_-]` so files never leave `directory`.
 * Writes are serialized per chat and replaced atomically.
 * @param directory Absolute storage directory.
 * @returns Store operations.
 */
export function createVideoDescriptionStore(directory: string) {
  const locks = new Map<string, Promise<unknown>>();
  const warned = new Set<string>();

  /**
   * Resolve the JSON file of a chat.
   * @param chatId Adapter chat id; unsafe characters become `_`.
   * @returns File path inside the storage directory.
   */
  function chatFile(chatId: string) {
    return resolvePath(`${String(chatId).replace(/[^A-Za-z0-9_-]/g, "_")}.json`, directory);
  }

  /**
   * Read entries in storage order (oldest first); missing or invalid files read as empty.
   * A parse error is logged once per file.
   * @param chatId Chat id.
   * @returns Stored entries.
   */
  async function load(chatId: string): Promise<VideoDescription[]> {
    const file = chatFile(chatId);
    try {
      const data = await Bun.file(file).json();
      return Array.isArray(data) ? data : [];
    } catch (error) {
      if (error?.code !== "ENOENT" && !warned.has(file)) {
        warned.add(file);
        console.error("Failed to load video descriptions:", error);
      }
      return [];
    }
  }

  /**
   * Serialize operations for one chat and release completed locks.
   * @param chatId Chat id.
   * @param task Protected operation.
   * @returns Operation result.
   */
  function withLock<T>(chatId: string, task: () => Promise<T>) {
    const previous = locks.get(chatId) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(task);
    locks.set(chatId, next);
    next
      .finally(() => {
        if (locks.get(chatId) === next) locks.delete(chatId);
      })
      .catch(() => {});
    return next;
  }

  return {
    /**
     * Insert or replace the entry with the same `messageId`, truncating the description
     * to 2000 characters and keeping the newest 100 entries.
     * @param chatId Chat id.
     * @param entry Entry to store.
     * @returns The saved entry.
     */
    save(chatId: string, entry: VideoDescription) {
      return withLock(chatId, async () => {
        const saved = { ...entry, description: entry.description.slice(0, MAX_DESCRIPTION_LENGTH) };
        const entries = (await load(chatId)).filter((item) => item.messageId !== saved.messageId);
        entries.push(saved);
        while (entries.length > MAX_ENTRIES) entries.shift();
        await replaceFileAtomically(chatFile(chatId), JSON.stringify(entries, null, 2), {
          createPath: true,
        });
        return saved;
      });
    },
    /**
     * Find an entry by message id.
     * @param chatId Chat id.
     * @param messageId Message id.
     * @returns The entry or null.
     */
    async get(chatId: string, messageId: string) {
      return (await load(chatId)).find((item) => item.messageId === messageId) ?? null;
    },
    /**
     * Find an entry by the platform's stable file id, to reuse text for forwarded media.
     * @param chatId Chat id.
     * @param fileUniqueId Stable file id.
     * @returns The newest matching entry or null.
     */
    async findByFile(chatId: string, fileUniqueId: string) {
      const entries = await load(chatId);
      return entries.findLast((item) => item.fileUniqueId === fileUniqueId) ?? null;
    },
    /**
     * List the newest entries first.
     * @param chatId Chat id.
     * @param limit Maximum number of entries.
     * @returns Entries, newest first.
     */
    async list(chatId: string, limit: number) {
      return (await load(chatId)).reverse().slice(0, Math.max(0, limit));
    },
  };
}

/** Video-description store operations. */
export type VideoDescriptionStore = ReturnType<typeof createVideoDescriptionStore>;
