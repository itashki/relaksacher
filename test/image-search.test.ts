import type {ImageCandidate, RequestContext} from "../src/types.ts";
/** @file Image search parsing and session-scoped image delivery. */
import test from "node:test";
import assert from "node:assert/strict";
import { createImageSearch } from "./fixtures.ts";
import { createToolService } from "./fixtures.ts";

test("DuckDuckGo image search normalizes results and rejects private URLs and duplicates", async () => {
  const search = createImageSearch(async (query, options, transport) => {
    assert.equal(query, "elephant");
    assert.equal(typeof options.safeSearch, "number");
    assert.equal(transport.response_timeout, 12000);
    return { results: [
      { title: "Elephant", image: "https://images.example.org/elephant.jpg", url: "https://example.org/elephant" },
      { title: "Duplicate", image: "https://images.example.org/elephant.jpg", url: "https://example.org/other" },
      { image: "http://127.0.0.1/image.jpg", url: "https://example.org/" },
      { image: "https://images.example.org/private.jpg", url: "http://localhost/" },
      { image: "javascript:alert(1)", url: "https://example.org/" },
    ] };
  });
  assert.deepEqual(await search("  elephant  "), [{ title: "Elephant", url: "https://images.example.org/elephant.jpg", sourceUrl: "https://example.org/elephant" }]);
});

test("image search limits results, skips blank queries and surfaces provider errors", async () => {
  let calls = 0;
  const search = createImageSearch(async () => { calls++; return { results: Array.from({ length: 10 }, (_, i) => ({
    title: "Image", image: `https://example.org/${i}.jpg`, url: "https://example.org/",
  })) }; });
  assert.deepEqual(await search(" "), []);
  assert.equal(calls, 0);
  assert.equal((await search("cats")).length, 5);
  await assert.rejects(createImageSearch(async () => { throw new Error("blocked"); }, async () => { throw new Error("blocked"); })("cats"), /blocked/);
  await assert.rejects(createImageSearch(async () => ({}), async () => "<html></html>")("cats"), /Image search unavailable/);
});

test("image delivery accepts only searched ids and limits sends to one per session", async () => {
  const delivered: ImageCandidate[] = [];
  const image = { title: "Elephant", url: "https://upload.wikimedia.org/elephant.jpg", sourceUrl: "https://commons.wikimedia.org/wiki/File:Elephant.jpg" };
  const service = createToolService({ memory: {}, imageSearch: async () => [image] });
  const context: RequestContext = { imageState: { candidates: new Map(), sent: false }, sendImage: async (candidate) => { delivered.push(candidate); } };
  const call = (name: string, args: Record<string, unknown>) => service.runTool({ function: { name, arguments: args } }, context);
  assert.match(await call("send_image", { id: "invented" }), /Неизвестный/);
  const [candidate] = JSON.parse(await call("search_images", { query: "elephant" }));
  assert.match(await call("send_image", { id: candidate.id }), /отправлено/);
  assert.match(await call("send_image", { id: candidate.id }), /уже отправлена/);
  assert.deepEqual(delivered, [image]);
  assert.ok(!service.definitions({}).some((tool) => tool.function.name === "send_image"));
  assert.ok(service.definitions({ images: true }).some((tool) => tool.function.name === "send_image"));
});

test("Bing image fallback is used when DuckDuckGo fails", async () => {
  const metadata = JSON.stringify({ turl: "https://ts1.mm.bing.net/cat.jpg", murl: "https://example.org/cat.jpg", purl: "https://example.org/cats", t: "Cat" });
  const search = createImageSearch(async () => { throw new Error("blocked"); }, async (url) => {
    assert.equal(new URL(url).hostname, "www.bing.com");
    return `<a class="iusc" m='${metadata}'></a>`;
  });
  assert.deepEqual(await search("cat"), [{ title: "Cat", url: "https://ts1.mm.bing.net/cat.jpg", sourceUrl: "https://example.org/cats" }]);
});
