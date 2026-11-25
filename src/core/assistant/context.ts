/** @file Estimate model input size and trim optional history while retaining the current request. */
import type { Message, Tool } from "ollama";
const CUT_NOTE = "Результат обрезан из-за размера контекста.";

// Approximation, not a tokenizer: leave headroom for generation and tool schemas.
// The divisor was calibrated against llama-server usage.prompt_tokens for Russian text (bytes/3 overcounted about 2x).
/**
 * Estimate input tokens without treating base64 image bytes as text.
 * @param input Model input.
 * @returns Approximate token count, including a fixed image allowance.
 */
const estimateTokens = ({
  messages,
  tools,
}: {
  messages: import("../../types.ts").ChatMessage[];
  tools: import("../../types.ts").ToolDefinition[] | undefined;
}) => {
  const text = messages.map(({ images: _images, ...entry }) => entry);
  const images = messages.reduce((sum, entry) => sum + (entry.images?.length ?? 0), 0);
  return (
    Math.ceil(JSON.stringify({ messages: text, tools }).length / 2.5) + images * 1536 // images are downscaled to 1280 px before sending; measured 1280x960 PNG = 1202 tokens, plus margin
  );
};

/**
 * Mutate history in place to fit a budget; never throws for size alone.
 * Drops old turns first; if only the current turn remains, truncates current-round tool results
 * (in order) and then the current user text, keeping their start and appending a note.
 * System message and tool schemas stay intact, so a huge schema may still exceed the budget.
 * @param messages Messages to trim in place.
 * @param tools Current round's schemas.
 * @param numCtx Context window; invalid values disable this guard.
 * @returns Whether old turns were removed.
 */
export function guardContext(messages: Message[], tools: Tool[], numCtx: number) {
  if (!Number.isSafeInteger(numCtx) || numCtx <= 0) return { trimmed: false };
  const budget = numCtx - Math.min(8192, Math.max(512, Math.floor(numCtx / 4)));
  let trimmed = false;
  while (estimateTokens({ messages, tools }) > budget) {
    const current = messages.findLastIndex((entry) => entry.role === "user");
    if (current <= 1) {
      const targets = [
        ...messages.flatMap((entry, i) => (i > current && entry.role === "tool" ? [i] : [])),
        current,
      ];
      for (const i of targets) {
        const excess = estimateTokens({ messages, tools }) - budget;
        if (excess <= 0) break;
        const { content } = messages[i];
        // 3 chars/token (> the 2.5 estimate) covers JSON escaping; slice(0, 0) leaves only the note.
        const keep = Math.max(0, content.length - excess * 3 - CUT_NOTE.length);
        if (keep < content.length) {
          messages[i] = { ...messages[i], content: `${content.slice(0, keep)}\n${CUT_NOTE}` };
        }
      }
      break;
    }
    // Drop complete old turns, never the current user message or its tool rounds.
    const next = messages.findIndex((entry, index) => index > 1 && entry.role === "user");
    messages.splice(1, (next === -1 ? current : next) - 1);
    if (!trimmed && !messages[0].content.includes("Часть старой истории удалена")) {
      messages[0] = {
        ...messages[0],
        content: `${messages[0].content}\nЧасть старой истории удалена из-за размера контекста. Не выдумывай пропущенные детали; если они нужны, попроси уточнение.`,
      };
    }
    trimmed = true;
  }
  return { trimmed };
}
