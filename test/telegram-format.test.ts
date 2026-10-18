import test from "node:test";
import assert from "node:assert/strict";
import { formatTelegramChunks } from "../src/adapters/telegram-format.ts";

test("renders Markdown using Telegram tags instead of visible markers", () => {
  const [text] = formatTelegramChunks("# Title\n\n**bold** and *italic* with ~~strike~~ and `code`\n\n[site](https://example.org)");
  assert.match(text, /<b>Title<\/b>/);
  assert.match(text, /<b>bold<\/b>/);
  assert.match(text, /<i>italic<\/i>/);
  assert.match(text, /<s>strike<\/s>/);
  assert.match(text, /<code>code<\/code>/);
  assert.match(text, /<a href="https:\/\/example.org">site<\/a>/);
  assert.doesNotMatch(text, /<h1>|<p>|\*\*|~~/);
});

test("escapes untrusted HTML and code and rejects unsupported link schemes", () => {
  const [text] = formatTelegramChunks('<script>alert(1)</script>\n\n`a < b && c`\n\n[x](javascript:alert)');
  assert.doesNotMatch(text, /<script>|href="javascript:/);
  assert.match(text, /&lt;script&gt;/);
  assert.match(text, /<code>a &lt; b &amp;&amp; c<\/code>/);
});

test("splits long formatted code into balanced messages with model aliases", () => {
  const chunks = formatTelegramChunks('```js\n' + '<😀>'.repeat(3000) + '\n```', "терн");
  assert.ok(chunks.length > 1);
  for (const chunk of chunks) {
    assert.match(chunk, /^<pre>/);
    assert.match(chunk, /<\/pre>\n\n· терн$/);
    const decoded = chunk.replace(/<[^>]*>/g, "").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
    assert.ok(decoded.length <= 3800);
  }
});

test("unfinished Markdown during streaming still produces closed HTML tags", () => {
  const [text] = formatTelegramChunks('```\nconst a = 1;');
  assert.equal(text, '<pre>const a = 1;</pre>');
});

test("long text uses balanced expandable quotes while signatures remain visible", () => {
  const chunks = formatTelegramChunks("**Long answer:** " + "paragraph ".repeat(900), "терн");
  assert.ok(chunks.length > 1);
  for (const chunk of chunks) {
    assert.match(chunk, /^<blockquote expandable>/);
    assert.match(chunk, /<\/blockquote>\n\n· терн$/);
    assert.equal((chunk.match(/<blockquote expandable>/g) ?? []).length, 1);
  }
  assert.doesNotMatch(formatTelegramChunks("short answer")[0], /blockquote/);
});

test("long answers leave code blocks outside expandable quotes", () => {
  const [text] = formatTelegramChunks("intro ".repeat(200) + "\n\n```\ncode\n```\n\nmore text");
  assert.match(text, /<\/blockquote><pre>code<\/pre>/);
  assert.match(text, /<blockquote expandable>more text<\/blockquote>$/);
});

test("short multiline answers collapse when rendered line count exceeds eight", () => {
  const [text] = formatTelegramChunks(Array.from({ length: 9 }, (_, i) => `line ${i}`).join("\n"));
  assert.match(text, /^<blockquote expandable>/);
  assert.doesNotMatch(formatTelegramChunks("one\ntwo\nthree")[0], /blockquote/);
});

test("soft wrapping and blank lines count toward the compact display limit", () => {
  assert.match(formatTelegramChunks("x".repeat(481))[0], /blockquote expandable/);
  assert.match(formatTelegramChunks("a\n\nb\n\nc\n\nd\n\ne")[0], /blockquote expandable/);
  assert.doesNotMatch(formatTelegramChunks("x".repeat(480))[0], /blockquote/);
});
