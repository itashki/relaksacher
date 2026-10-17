/** @file Implementation of adapters/telegram-format. */
import { marked } from "marked";

/**
 * Escape untrusted text for Telegram HTML.
 * @param {string} text Raw visible text.
 * @returns {string} Escaped HTML text.
 */
const escapeHtml = (text) => String(text).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

// Render only Telegram-supported tags; model-provided HTML is always escaped.
// Split decoded text before escaping, reopening formatting in every message.
/**
 * Convert Markdown into balanced Telegram HTML chunks with compact long-text quotes.
 * @param {string} markdown Model text, possibly incomplete during streaming.
 * @param {string} [alias] Public signature placed outside collapsible blocks.
 * @param {number} [limit=3800] Maximum visible UTF-16 units per chunk including signature.
 * @returns {string[]} Escaped HTML messages with independently balanced tags.
 */
export function formatTelegramChunks(markdown, alias, limit = 3800) {
  const runs = [];
  /**
   * Collect visible text with its formatting stack.
   * @param {string} text Visible run.
   * @param {Array<[string, string]>} [tags] Opening/closing tag pairs.
   * @returns {void}
   */
  const add = (text, tags = []) => { if (text) runs.push({ text, tags }); };
  /**
   * Flatten marked tokens into visible text runs with supported formatting.
   * @param {import("marked").Token[]} tokens Parsed Markdown tokens.
   * @param {Array<[string, string]>} [tags] Inherited tag stack.
   * @returns {void}
   */
  function walk(tokens, tags = []) {
    for (const token of tokens) {
      /**
       * Render nested inline tokens under an additional HTML tag.
       * @param {string} tag Opening tag, optionally with attributes.
       * @returns {void}
       */
      const wrap = (tag) => walk(token.tokens ?? [], [...tags, [tag, tag.replace(/ .*/, "")]]);
      switch (token.type) {
        case "strong": wrap("b"); break;
        case "em": wrap("i"); break;
        case "del": wrap("s"); break;
        case "codespan": add(token.text, [...tags, ["code", "code"]]); break;
        case "code": add(token.text, [["pre", "pre"]]); add("\n\n"); break;
        case "link":
          if (/^https?:\/\//i.test(token.href)) wrap(`a href="${escapeHtml(token.href)}"`);
          else walk(token.tokens ?? [], tags);
          break;
        case "image": add(token.text, tags); break;
        case "heading": wrap("b"); add("\n\n"); break;
        case "paragraph": walk(token.tokens ?? [], tags); add("\n\n"); break;
        case "blockquote": walk(token.tokens ?? [], tags); break;
        case "list":
          token.items.forEach((item, index) => {
            add(token.ordered ? `${Number(token.start) + index}. ` : "• ", tags);
            walk(item.tokens, tags);
            add("\n");
          });
          add("\n");
          break;
        case "table":
          for (const row of [token.header, ...token.rows]) {
            row.forEach((cell, index) => { if (index) add(" | "); walk(cell.tokens, tags); });
            add("\n");
          }
          add("\n");
          break;
        case "br": add("\n", tags); break;
        case "space": add("\n"); break;
        case "hr": add("—\n\n"); break;
        default:
          if (token.tokens) walk(token.tokens, tags);
          else add(token.text ?? token.raw ?? "", tags);
      }
    }
  }
  walk(marked.lexer(markdown || "…"));
  while (runs.length && !runs.at(-1).text.trim()) runs.pop();
  if (runs.length) runs.at(-1).text = runs.at(-1).text.trimEnd();
  const visibleText = runs.map((run) => run.text).join("");
  // Approximate soft wrapping as well as explicit line breaks, including blanks.
  const estimatedLines = visibleText.split(/\r\n|\r|\n/)
    .reduce((sum, line) => sum + Math.max(1, Math.ceil(Array.from(line).length / 60)), 0);
  const expandable = Array.from(visibleText).length > 600 || estimatedLines > 8;
  const footer = alias ? `\n\n· ${escapeHtml(alias)}` : "";
  const budget = limit - (alias ? alias.length + 4 : 0);
  const chunks = [];
  let current = "";
  let length = 0;
  let quoteOpen = false;
  /**
   * Close the current expandable quote before a boundary or code block.
   * @returns {void}
   */
  const closeQuote = () => {
    if (quoteOpen) current += "</blockquote>";
    quoteOpen = false;
  };
  /**
   * Close formatting and append a complete message with its signature.
   * @returns {void}
   */
  const finishChunk = () => {
    closeQuote();
    chunks.push((current || "…") + footer);
    current = "";
    length = 0;
  };
  for (const { text, tags } of runs) {
    let part = "";
    /**
     * Append the buffered run, keeping code outside expandable quotes.
     * @returns {void}
     */
    const emit = () => {
      if (part) {
        // Keep code/pre outside quotes to avoid unsupported entity nesting.
        const code = tags.some(([, close]) => close === "pre" || close === "code");
        if (code) closeQuote();
        else if (expandable && !quoteOpen && part.trim()) {
          current += "<blockquote expandable>";
          quoteOpen = true;
        }
        current += tags.map(([open]) => `<${open}>`).join("") + escapeHtml(part) + [...tags].reverse().map(([, close]) => `</${close}>`).join("");
      }
      part = "";
    };
    for (const char of text) {
      if (length + char.length > budget) {
        emit(); finishChunk();
      }
      part += char;
      length += char.length;
    }
    emit();
  }
  if (current || !chunks.length) finishChunk();
  return chunks;
}
