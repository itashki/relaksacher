/** @file Regression coverage for telegram format behavior and its external boundaries. */
import { expect, test } from "bun:test";
import { formatTelegramChunks } from "../../src/adapters/telegram/format.ts";

test("renders Markdown using Telegram tags instead of visible markers", () => {
  const [text] = formatTelegramChunks(
    "# Title\n\n**bold** and *italic* with ~~strike~~ and `code`\n\n[site](https://example.org)",
  );
  expect(text).toMatch(/<b>Title<\/b>/);
  expect(text).toMatch(/<b>bold<\/b>/);
  expect(text).toMatch(/<i>italic<\/i>/);
  expect(text).toMatch(/<s>strike<\/s>/);
  expect(text).toMatch(/<code>code<\/code>/);
  expect(text).toMatch(/<a href="https:\/\/example.org">site<\/a>/);
  expect(text).not.toMatch(/<h1>|<p>|\*\*|~~/);
});

test("escapes untrusted HTML and code and rejects unsupported link schemes", () => {
  const [text] = formatTelegramChunks(
    "<script>alert(1)</script>\n\n`a < b && c`\n\n[x](javascript:alert)",
  );
  expect(text).not.toMatch(/<script>|href="javascript:/);
  expect(text).toMatch(/&lt;script&gt;/);
  expect(text).toMatch(/<code>a &lt; b &amp;&amp; c<\/code>/);
});

test("splits long formatted code into balanced messages with model aliases", () => {
  const chunks = formatTelegramChunks("```js\n" + "<😀>".repeat(3000) + "\n```", "терн");
  expect(chunks.length > 1).toBeTruthy();
  for (const chunk of chunks) {
    expect(chunk).toMatch(/^<pre>/);
    expect(chunk).toMatch(/<\/pre>\n\n· терн$/);
    const decoded = chunk
      .replace(/<[^>]*>/g, "")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&amp;/g, "&");
    expect(decoded.length <= 3800).toBeTruthy();
  }
});

test("unfinished Markdown during streaming still produces closed HTML tags", () => {
  const [text] = formatTelegramChunks("```\nconst a = 1;");
  expect(text).toBe("<pre>const a = 1;</pre>");
});

test("long text uses balanced expandable quotes while signatures remain visible", () => {
  const chunks = formatTelegramChunks("**Long answer:** " + "paragraph ".repeat(900), "терн");
  expect(chunks.length > 1).toBeTruthy();
  for (const chunk of chunks) {
    expect(chunk).toMatch(/^<blockquote expandable>/);
    expect(chunk).toMatch(/<\/blockquote>\n\n· терн$/);
    expect((chunk.match(/<blockquote expandable>/g) ?? []).length).toBe(1);
  }
  expect(formatTelegramChunks("short answer")[0]).not.toMatch(/blockquote/);
});

test("long answers leave code blocks outside expandable quotes", () => {
  const [text] = formatTelegramChunks("intro ".repeat(200) + "\n\n```\ncode\n```\n\nmore text");
  expect(text).toMatch(/<\/blockquote><pre>code<\/pre>/);
  expect(text).toMatch(/<blockquote expandable>more text<\/blockquote>$/);
});

test("short multiline answers collapse when rendered line count exceeds eight", () => {
  const [text] = formatTelegramChunks(Array.from({ length: 9 }, (_, i) => `line ${i}`).join("\n"));
  expect(text).toMatch(/^<blockquote expandable>/);
  expect(formatTelegramChunks("one\ntwo\nthree")[0]).not.toMatch(/blockquote/);
});

test("soft wrapping and blank lines count toward the compact display limit", () => {
  expect(formatTelegramChunks("x".repeat(481))[0]).toMatch(/blockquote expandable/);
  expect(formatTelegramChunks("a\n\nb\n\nc\n\nd\n\ne")[0]).toMatch(/blockquote expandable/);
  expect(formatTelegramChunks("x".repeat(480))[0]).not.toMatch(/blockquote/);
});
