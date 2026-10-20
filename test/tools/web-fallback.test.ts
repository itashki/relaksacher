import { fixture } from "../support/fixtures.ts";
import type { WebClient, WebSearchResult } from "../../src/types.ts";
/** @file Regression tests for Ollama-first search and credential-free fallback. */
import { expect, test, spyOn, onTestFinished } from "bun:test";
import {
  createWebFallback,
  createWebClient,
  validatePublicUrl,
  fetchText,
} from "../../src/core/tools/web-fallback.ts";
import { createToolService } from "../support/fixtures.ts";

test("Bun DNS rejects mixed public/private answers and propagates lookup failures", async () => {
  const lookup = spyOn(Bun.dns, "lookup");
  onTestFinished(() => lookup.mockRestore());
  lookup.mockResolvedValue([
    { address: "93.184.216.34", family: 4, ttl: 60 },
    { address: "127.0.0.1", family: 4, ttl: 60 },
  ]);
  await expect(fetchText("https://dns-check.invalid/")).rejects.toThrow(
    /Non-public address blocked/,
  );
  expect(lookup).toHaveBeenCalledWith(
    "dns-check.invalid",
    expect.objectContaining({ backend: "system" }),
  );
  lookup.mockResolvedValue([]);
  await expect(fetchText("https://dns-check.invalid/")).rejects.toThrow(
    /Non-public address blocked/,
  );
  lookup.mockRejectedValue(new Error("Lookup failed"));
  await expect(fetchText("https://dns-check.invalid/")).rejects.toThrow(/Lookup failed/);
});

test("DuckDuckGo results decode redirect URLs and skip ads", async () => {
  const client = createWebFallback({
    getText: async (url) => {
      expect(url).toMatch(/q=hello%20world/);
      return `<div class="result"><a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.org%2Fpage">Example &amp; title</a><span class="result__snippet">A snippet</span></div>
    <div class="result result--ad"><a class="result__a" href="https://advert.example">Ad</a></div>`;
    },
  });
  const result = await client.webSearch({ query: "hello world", max_results: 5 });
  expect(result.results).toStrictEqual([
    { title: "Example & title", url: "https://example.org/page", content: "A snippet" },
  ]);
});

test("CAPTCHA/unknown markup fails honestly and pages omit executable/navigation text", async () => {
  await expect(
    createWebFallback({ getText: async () => "<form>CAPTCHA</form>" }).webSearch({ query: "test" }),
  ).rejects.toThrow(/CAPTCHA/);
  const result = await createWebFallback({
    getText: async () =>
      '<title>Title</title><nav>Menu</nav><main>Content<script>bad()</script><a href="/source">Source</a></main>',
  }).webFetch({ url: "https://example.org/" });
  expect(result.title).toBe("Title");
  expect(result.content).not.toMatch(/bad|Menu/);
  expect(result.links).toStrictEqual(["https://example.org/source"]);
});

test("primary search is preferred; failures and empty results use fallback", async () => {
  let fallbackCalls = 0;
  const fallback = fixture<WebClient>({
    async webSearch() {
      fallbackCalls++;
      return { results: [{ content: "fallback" }] };
    },
  });
  expect(
    await createWebClient(
      fixture<WebClient>({ webSearch: async () => ({ results: [{ content: "primary" }] }) }),
      fallback,
    ).webSearch({ query: "test" }),
  ).toStrictEqual({ results: [{ content: "primary" }] });
  expect(fallbackCalls).toBe(0);
  for (const webSearch of [
    async () => {
      throw new Error("unavailable");
    },
    async () => ({ results: [] as WebSearchResult[] }),
  ]) {
    expect(
      await createWebClient(fixture<WebClient>({ webSearch }), fallback).webSearch({
        query: "test",
      }),
    ).toStrictEqual({ results: [{ content: "fallback" }] });
  }
  expect(fallbackCalls).toBe(2);
});

test("web tools are exposed without an Ollama API key", () => {
  const service = createToolService({ memory: {} });
  expect(
    service
      .definitions({ search: true } as Parameters<typeof service.definitions>[0])
      .map((tool) => tool.function.name),
  ).toStrictEqual(["web_search", "web_fetch", "weather_forecast"]);
});

test("local, private and credential-bearing page URLs are rejected", () => {
  for (const url of [
    "file:///etc/passwd",
    "http://localhost/",
    "http://127.0.0.1/",
    "http://192.168.1.1/",
    "http://169.254.169.254/",
    "http://[::1]/",
    "https://user:pass@example.org",
  ]) {
    expect(() => validatePublicUrl(url)).toThrow(/public/);
  }
  expect(validatePublicUrl("https://example.org/").hostname).toBe("example.org");
});

test("a stalled primary provider times out into fallback", async () => {
  const client = createWebClient(
    fixture<WebClient>({ webSearch: () => new Promise<never>(() => {}) }),
    fixture<WebClient>({ webSearch: async () => ({ results: [{ content: "fallback" }] }) }),
    5,
  );
  expect(await client.webSearch({ query: "test" })).toStrictEqual({
    results: [{ content: "fallback" }],
  });
});
