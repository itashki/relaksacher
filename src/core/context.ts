import type { Message, Tool } from "ollama";
/**
 * Indicates that required context cannot fit without dropping the current request.
 */
export class ContextLimitError extends Error {}

// Approximation, not a tokenizer: leave headroom for generation and tool schemas.
/**
 * Estimate input tokens without treating base64 image bytes as text.
 * @param input Model input.
 * @returns Approximate token count, including a fixed image allowance.
 */
const estimateTokens = ({ messages, tools }: { messages: import("../types.ts").ChatMessage[]; tools: import("../types.ts").ToolDefinition[] | undefined; }) => {
  const text = messages.map(({ images, ...entry }) => entry);
  const images = messages.reduce((sum, entry) => sum + (entry.images?.length ?? 0), 0);
  return Math.ceil(new TextEncoder().encode(JSON.stringify({ messages: text, tools })).byteLength / 3) + images * 4096;
};

/**
 * Mutate history in place to fit a budget, preserving the system/current tool turn.
 * @param messages Messages to trim in place.
 * @param tools Current round's schemas.
 * @param numCtx Context window; invalid values disable this guard.
 * @returns Whether old turns were removed.
 * @throws {ContextLimitError} When essential context alone exceeds the budget.
 */
export function guardContext(messages: Message[], tools: Tool[], numCtx: number) {
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
