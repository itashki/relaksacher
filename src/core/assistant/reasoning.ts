/** @file Hide explicit reasoning blocks returned inside model content instead of thinking. */

const tags = ["<think>", "</think>", "<analysis>", "</analysis>"];

/**
 * Filter a cumulative content snapshot, including incomplete tags and unclosed blocks.
 * Reserved reasoning delimiters are private even inside Markdown or quoted text.
 * Recompute from the raw snapshot so arbitrary stream chunk boundaries are safe.
 */
export function hideReasoning(text: string): string {
  let output = "";
  let depth = 0;
  for (let index = 0; index < text.length;) {
    if (text[index] === "<") {
      const end = text.indexOf(">", index);
      const candidate = text.slice(index, end < 0 ? undefined : end + 1).toLowerCase();
      if (
        end < 0 &&
        (tags.some((tag) => tag.startsWith(candidate)) ||
          /^<\/?(?:think|analysis)\s*$/u.test(candidate))
      )
        break;
      if (/^<\/?(?:think|analysis)\s*>$/u.test(candidate)) {
        if (candidate.startsWith("</")) depth = Math.max(0, depth - 1);
        else depth++;
        index = end + 1;
        continue;
      }
    }
    if (depth === 0) output += text[index];
    index++;
  }
  return output;
}
