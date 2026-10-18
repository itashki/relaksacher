/** @file Regression tests for Ollama-first search and credential-free fallback. */
import test from "node:test";
import assert from "node:assert/strict";
import { createWebFallback, createWebClient, validatePublicUrl } from "../src/core/web-fallback.js";
import { createToolService } from "../src/core/tools.js";

test("DuckDuckGo results decode redirect URLs and skip ads", async () => {
  const client = createWebFallback({ getText: async (url) => {
    assert.match(url, /q=hello%20world/);
    return `<div class="result"><a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.org%2Fpage">Example &amp; title</a><span class="result__snippet">A snippet</span></div>
    <div class="result result--ad"><a class="result__a" href="https://advert.example">Ad</a></div>`;
  } });
  const result = await client.webSearch({ query: "hello world", max_results: 5 });
  assert.deepEqual(result.results, [{ title: "Example & title", url: "https://example.org/page", content: "A snippet" }]);
});

test("CAPTCHA/unknown markup fails honestly and pages omit executable/navigation text", async () => {
  await assert.rejects(createWebFallback({ getText: async () => "<form>CAPTCHA</form>" }).webSearch({ query: "test" }), /CAPTCHA/);
  const result = await createWebFallback({ getText: async () => '<title>Title</title><nav>Menu</nav><main>Content<script>bad()</script><a href="/source">Source</a></main>' }).webFetch({ url: "https://example.org/" });
  assert.equal(result.title, "Title");
  assert.doesNotMatch(result.content, /bad|Menu/);
  assert.deepEqual(result.links, ["https://example.org/source"]);
});

test("primary search is preferred; failures and empty results use fallback", async () => {
  let fallbackCalls = 0;
  const fallback = { async webSearch() { fallbackCalls++; return { results: ["fallback"] }; } };
  assert.deepEqual(await createWebClient({ webSearch: async () => ({ results: ["primary"] }) }, fallback).webSearch({}), { results: ["primary"] });
  assert.equal(fallbackCalls, 0);
  for (const webSearch of [async () => { throw new Error("unavailable"); }, async () => ({ results: [] })]) {
    assert.deepEqual(await createWebClient({ webSearch }, fallback).webSearch({}), { results: ["fallback"] });
  }
  assert.equal(fallbackCalls, 2);
});

test("web tools are exposed without an Ollama API key", () => {
  const service = createToolService({ memory: {} });
  assert.equal(service.searchEnabled, true);
  assert.deepEqual(service.definitions({ search: true }).map((tool) => tool.function.name), ["web_search", "web_fetch"]);
});

test("local, private and credential-bearing page URLs are rejected", () => {
  for (const url of ["file:///etc/passwd", "http://localhost/", "http://127.0.0.1/", "http://192.168.1.1/", "http://169.254.169.254/", "http://[::1]/", "https://user:pass@example.org"]) {
    assert.throws(() => validatePublicUrl(url), /public/);
  }
  assert.equal(validatePublicUrl("https://example.org/").hostname, "example.org");
});

test("a stalled primary provider times out into fallback", async () => {
  const client = createWebClient({ webSearch: () => new Promise(() => {}) },
    { webSearch: async () => ({ results: ["fallback"] }) }, 5);
  assert.deepEqual(await client.webSearch({}), { results: ["fallback"] });
});
