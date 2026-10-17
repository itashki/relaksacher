export class ContextLimitError extends Error {}

// Approximation, not a tokenizer: leave headroom for generation and tool schemas.
const estimateTokens = ({ messages, tools }) => {
  const text = messages.map(({ images, ...entry }) => entry);
  const images = messages.reduce((sum, entry) => sum + (entry.images?.length ?? 0), 0);
  return Math.ceil(Buffer.byteLength(JSON.stringify({ messages: text, tools }), "utf8") / 3) + images * 4096;
};

export function guardContext(messages, tools, numCtx) {
  if (!Number.isSafeInteger(numCtx) || numCtx <= 0) return { trimmed: false };
  const budget = numCtx - Math.min(8192, Math.max(512, Math.floor(numCtx / 4)));
  let trimmed = false;
  while (estimateTokens({ messages, tools }) > budget) {
    const current = messages.findLastIndex((entry) => entry.role === "user");
    if (current <= 1) {
      throw new ContextLimitError("Current request and required context exceed the input budget");
    }
    // Drop complete old turns, never the current user message or its tool rounds.
    const next = messages.findIndex((entry, index) => index > 1 && entry.role === "user");
    messages.splice(1, (next === -1 ? current : next) - 1);
    if (!trimmed && !messages[0].content.includes("Часть старой истории удалена")) {
      messages[0] = { ...messages[0], content: `${messages[0].content}\nЧасть старой истории удалена из-за размера контекста. Не выдумывай пропущенные детали; если они нужны, попроси уточнение.` };
    }
    trimmed = true;
  }
  return { trimmed };
}
