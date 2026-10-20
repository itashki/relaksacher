/** @file Telegram text chunks, author identity, image selection and burst merging. */
/**
 * Split text into UTF-16-bounded pieces without breaking surrogate pairs.
 * @param text Raw answer for cached reply-chain reconstruction.
 * @param limit Chunk size in UTF-16 units.
 * @returns Nonempty list of chunks.
 */
export function splitText(text: string, limit: number = 3800) {
  const chunks = [];
  let chunk = "";
  for (const char of text) {
    if (chunk.length + char.length > limit) {
      chunks.push(chunk);
      chunk = "";
    }
    chunk += char;
  }
  chunks.push(chunk || "…");
  return chunks;
}

const groupedImages = new WeakMap<import("@grammyjs/types").Message, string[]>();

/**
 * Select the largest photo or a supported image document.
 * @param message Telegram message.
 * @returns Downloadable file identifiers.
 */
export function imageFiles(message: import("@grammyjs/types").Message) {
  if (groupedImages.has(message)) return groupedImages.get(message);
  if (message.photo?.length) return [message.photo.at(-1).file_id];
  if (/^image\/(jpeg|png|webp)$/.test(message.document?.mime_type ?? ""))
    return [message.document.file_id];
  return [];
}

/**
 * Format Telegram user identity for the model.
 * @param user Message author.
 * @returns Name, optional username and identifier.
 */
export function author(user: import("@grammyjs/types").User) {
  return `${[user.first_name, user.last_name].filter(Boolean).join(" ") || user.username || user.id} (username: ${user.username ?? "нет"}, id: ${user.id})`;
}

/** Combine one author's message burst while preserving entities and image file IDs. */
export function mergeTelegramMessages(messages: import("@grammyjs/types").Message[]) {
  const first = messages[0];
  let text = "";
  const entities: import("@grammyjs/types").MessageEntity[] = [];
  for (const message of messages) {
    const part = message.text ?? message.caption ?? "";
    const offset = text.length + (text && part ? 1 : 0);
    for (const entity of message.entities ?? message.caption_entities ?? [])
      entities.push({ ...entity, offset: entity.offset + offset });
    if (part) text += (text ? "\n" : "") + part;
  }
  const combined = { ...first, text, entities };
  groupedImages.set(combined, messages.flatMap(imageFiles));
  return combined;
}

/** Preserve a burst's image IDs when constructing another message object for history or model input. */
export function rememberTelegramImages(
  message: import("@grammyjs/types").Message,
  images: string[],
) {
  groupedImages.set(message, images);
}
