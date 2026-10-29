/** @file Keep generated author metadata out of streamed replies and explain incomplete answers. */

/**
 * Remove reserved author headers at line starts, outside fenced code and quoted text.
 * Hold incomplete header prefixes during streaming so names/IDs never flash in chat.
 * Preserve ordinary prose, Markdown, roleplay actions and literal examples inside code.
 */
export function cleanAssistantText(text: string, final = true) {
  const output: string[] = [];
  let fence: { marker: string; length: number } | undefined;
  let removed = false;
  const lines = text.split("\n");
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    const boundary = line.match(/^ {0,3}(`{3,}|~{3,})/);
    if (boundary) {
      const marker = boundary[1];
      if (!fence) fence = { marker: marker[0], length: marker.length };
      else if (
        marker[0] === fence.marker &&
        marker.length >= fence.length &&
        line.trim() === marker
      )
        fence = undefined;
      output.push(line);
      continue;
    }
    if (fence) {
      output.push(line);
      continue;
    }
    const rawCandidate = line.trimStart().toLowerCase();
    const startsHeader = /^\[(?:автор|author)\s*:/iu.test(rawCandidate);
    const partialHeader = ["[автор", "[author"].some(
      (prefix) =>
        prefix.startsWith(rawCandidate) ||
        (rawCandidate.startsWith(prefix) && /^\s*:?\s*$/.test(rawCandidate.slice(prefix.length))),
    );
    // Wait for a whole metadata line: display names themselves may contain closing brackets.
    if (!final && index === lines.length - 1 && rawCandidate && (startsHeader || partialHeader)) {
      removed = true;
      continue;
    }
    if (startsHeader && line.includes("(username:") && !/\bid:\s*-?\d+\)\]/u.test(line)) {
      removed = true;
      continue;
    }
    const cleaned = line.replace(
      /^(?:[\t ]*\[(?:автор|author)\s*:(?:[^\r\n]*?\(username:[^\r\n]*?\bid:\s*-?\d+\)|[^\]\r\n]*)\][\t ]*(?:\\[nr])*)+/iu,
      "",
    );
    const candidate = cleaned.trimStart().toLowerCase();
    const header = /^\[(?:автор|author)\s*:/iu.test(candidate);
    const pending =
      !final &&
      index === lines.length - 1 &&
      candidate &&
      ["[автор:", "[author:"].some((prefix) => prefix.startsWith(candidate));
    if (header || pending) {
      removed = true;
      continue;
    }
    if (cleaned !== line) {
      removed = true;
      if (!cleaned.trim()) continue;
    }
    if (removed && output.length === 0 && !cleaned.trim()) continue;
    output.push(cleaned);
  }
  return removed ? output.join("\n").trimStart() : text;
}

/** Return the existing user-facing explanation for an incomplete generation. */
export function incompleteExplanation(reason: string) {
  switch (reason) {
    case "repetition":
      return "обнаружено зацикливание модели";
    case "context_limit":
      return "текущий запрос и обязательный контекст слишком велики; сократи запрос или начни новый диалог";
    case "length":
      return "достигнут лимит генерации";
    case "tool_limit":
      return "достигнут лимит вызовов инструментов";
    case "empty_answer":
      return "модель не вернула текст ответа";
    default:
      return "не подтверждено нормальное завершение генерации";
  }
}
