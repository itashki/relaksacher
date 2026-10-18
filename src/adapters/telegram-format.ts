import { marked } from "marked";

/**
 * Escape untrusted text for Telegram HTML.
 * @param text Raw visible text.
 * @returns Escaped HTML text.
 */
const escapeHtml = (text: string) => String(text).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

// Render only Telegram-supported tags; model-provided HTML is always escaped.
// Split decoded text before escaping, reopening formatting in every message.
/**
 * Convert Markdown into balanced Telegram HTML chunks with compact long-text quotes.
 * @param markdown Model text, possibly incomplete during streaming.
 * @param alias Public signature placed outside collapsible blocks.
 * @param limit Maximum visible UTF-16 units per chunk including signature.
 * @returns Escaped HTML messages with independently balanced tags.
 */
export function formatTelegramChunks(markdown: string, alias: string = "", limit: number = 3800) {
  const runs: {text: string; tags: [string, string][]}[] = [];
  /**
   * Collect visible text with its formatting stack.
   * @param text Visible run.
   * @param tags Opening/closing tag pairs.
   */
  const add = (text: string, tags: [string, string][] = []) => { if (text) runs.push({ text, tags }); };
  /**
   * Flatten marked tokens into visible text runs with supported formatting.
   * @param tokens Parsed Markdown tokens.
   * @param tags Inherited tag stack.
   */
  function walk(tokens: import("marked").Token[], tags: [string, string][] = []) {
    for (const token of tokens) {
      /**
       * Render nested inline tokens under an additional HTML tag.
       * @param tag Opening tag, optionally with attributes.
       */
      const wrap = (tag: string) => walk(("tokens" in token ? token.tokens : undefined) ?? [], [...tags, [tag, tag.replace(/ .*/, "")]]);
      switch (token.type) {
        case "strong": wrap("b"); break;
        case "em": wrap("i"); break;
        case "del": wrap("s"); break;
        case "codespan": add(token.text, [...tags, ["code", "code"]]); break;
        case "code": add(token.text, [["pre", "pre"]]); add("\n\n"); break;
        case "link":
          if (/^https?:\/\//i.test(token.href)) wrap(`a href="${escapeHtml(token.href)}"`);
          else walk(("tokens" in token ? token.tokens : undefined) ?? [], tags);
          break;
        case "image": add(token.text, tags); break;
        case "heading": wrap("b"); add("\n\n"); break;
        case "paragraph": walk(("tokens" in token ? token.tokens : undefined) ?? [], tags); add("\n\n"); break;
        case "blockquote": walk(("tokens" in token ? token.tokens : undefined) ?? [], tags); break;
        case "list":
          token.items.forEach((item: import("marked").Tokens.ListItem, index: number) => {
            add(token.ordered ? `${Number(token.start) + index}. ` : "• ", tags);
            walk(item.tokens, tags);
            add("\n");
          });
          add("\n");
          break;
        case "table":
          for (const row of [token.header, ...token.rows]) {
            row.forEach((cell: import("marked").Tokens.TableCell, index: number) => { if (index) add(" | "); walk(cell.tokens, tags); });
            add("\n");
          }
          add("\n");
          break;
        case "br": add("\n", tags); break;
        case "space": add("\n"); break;
        case "hr": add("—\n\n"); break;
        default:
          if ("tokens" in token && token.tokens) walk(token.tokens, tags);
          else add(("text" in token ? token.text : undefined) ?? token.raw ?? "", tags);
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
  const chunks: string[] = [];
  let current = "";
  let length = 0;
  let quoteOpen = false;
  /**
   * Close the current expandable quote before a boundary or code block.
   */
  const closeQuote = () => {
    if (quoteOpen) current += "</blockquote>";
    quoteOpen = false;
  };
  /**
   * Close formatting and append a complete message with its signature.
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
