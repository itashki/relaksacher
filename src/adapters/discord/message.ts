/** @file Discord message splitting, tool status text and image attachment selection. */
import { parseCommands, truncate } from "../../core/text.ts";

/**
 * Split Discord text at whitespace when possible, preserving Unicode code points.
 * @param content Raw text.
 * @param maxLength Maximum code points per chunk.
 * @returns Message pieces.
 */
export function splitMessage(content: string, maxLength: number = 2000) {
  const remaining = Array.from(content);
  const chunks = [];

  while (remaining.length > maxLength) {
    let splitAt = maxLength;
    for (let index = maxLength - 1; index >= Math.floor(maxLength / 2); index--) {
      if (/\s/u.test(remaining[index])) {
        splitAt = index + 1;
        break;
      }
    }

    chunks.push(remaining.splice(0, splitAt).join(""));
  }

  if (remaining.length > 0 || chunks.length === 0) {
    chunks.push(remaining.join(""));
  }

  return chunks;
}
// Короткий статус для отображения в Discord, пока выполняется инструмент.
/**
 * Render a short, temporary Discord status for a tool call.
 * @param call Active tool.
 * @returns Human-readable status.
 */
export function describeToolCall(call: import("../../types.ts").ToolCall) {
  const args = call.function.arguments ?? {};
  if (["search_images", "send_image"].includes(call.function.name)) return "🖼 Подбираю картинку";
  if (call.function.name === "read_history") return "📜 Читаю историю чата";
  if (call.function.name === "enable_thinking") {
    return "💭 Обдумываю запрос";
  }
  if (call.function.name === "web_search") {
    return `🔍 Ищу в интернете: ${truncate(args.query, 100)}`;
  }
  if (call.function.name === "web_fetch") {
    return `🌐 Открываю страницу: <${truncate(args.url, 150)}>`;
  }
  if (call.function.name === "remember") {
    return `🧠 Запоминаю: ${truncate(args.fact, 100)}`;
  }
  if (call.function.name === "forget") {
    return `🧠 Забываю запись #${truncate(args.id, 10)}`;
  }
  return `⚙️ Использую инструмент ${call.function.name}`;
}

/**
 * Collect supported image attachment URLs.
 * @param message Source message.
 * @returns Image URLs.
 */
export function imageFiles(message: import("discord.js").Message<boolean>) {
  return [...(message.attachments?.values() ?? [])]
    .filter(
      (file) =>
        /^image\/(jpeg|png|webp)$/.test(file.contentType ?? "") ||
        /\.(png|jpe?g|webp)$/i.test(file.name ?? ""),
    )
    .map((file) => file.url);
}

// Название треда: начало вопроса без упоминаний и команд (лимит Discord — 100).
/**
 * Build a short topic from the request, excluding commands and mentions.
 * @param message Source request.
 * @returns Thread title.
 */
export function threadName(message: import("discord.js").Message<boolean>) {
  const topic = parseCommands(message.content)
    .content.replace(/<[@#][!&]?\d+>/g, "")
    .replace(/\s+/g, " ")
    .trim();
  const author = message.member?.displayName ?? message.author.username;
  return truncate(topic || `Диалог с ${author}`, 90);
}

// Описание автора сообщения для модели: отображаемое имя, username и id.
/**
 * Describe an author consistently for model attribution.
 * @param entry Source message.
 * @returns Display name, username and identifier.
 */
export function describeAuthor(entry: import("discord.js").Message<boolean>) {
  const displayName = entry.member?.displayName ?? entry.author.globalName ?? entry.author.username;
  return `${displayName} (username: ${entry.author.username}, id: ${entry.author.id})`;
}
