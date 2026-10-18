/** @file GIF provider normalization, credential handling and tool delivery. */
import test from "node:test";
import assert from "node:assert/strict";
import { createGifSearch } from "../src/core/gif-search.js";
import { createToolService } from "../src/core/tools.js";

test("KLIPY search validates media, caps results and does not expose credentials", async () => {
  assert.equal(createGifSearch(), null);
  const search = createGifSearch({ apiKey: "secret", getText: async (url) => {
    const params = new URL(url).searchParams;
    assert.equal(params.get("key"), "secret");
    assert.equal(params.get("q"), "cat");
    return JSON.stringify({ results: [
      { title: "Cat", itemurl: "https://klipy.com/gifs/cat", media_formats: { tinygif: { url: "https://static.klipy.com/cat.gif", size: 100 } } },
      { itemurl: "https://klipy.com/gifs/private", media_formats: { tinygif: { url: "http://127.0.0.1/a.gif" } } },
      { itemurl: "https://klipy.com/gifs/huge", media_formats: { tinygif: { url: "https://static.klipy.com/huge.gif", size: 20000000 } } },
    ] });
  } });
  assert.deepEqual(await search("cat"), [{ title: "Cat", url: "https://static.klipy.com/cat.gif", sourceUrl: "https://klipy.com/gifs/cat", kind: "gif", provider: "KLIPY" }]);
  await assert.rejects(createGifSearch({ apiKey: "secret", getText: async () => { throw new Error("https://api.klipy.com/?key=secret"); } })("cat"), (error) => !error.message.includes("secret"));
});

test("GIF tools are opt-in and share the image delivery limit", async () => {
  const gif = { title: "Cat", url: "https://static.klipy.com/cat.gif", sourceUrl: "https://klipy.com/gifs/cat", kind: "gif" };
  const delivered = [];
  const service = createToolService({ memory: {}, gifSearch: async () => [gif] });
  const context = { imageState: { candidates: new Map(), sent: false }, sendImage: async (image) => delivered.push(image) };
  const call = (name, args) => service.runTool({ function: { name, arguments: args } }, context);
  assert.ok(service.definitions({ images: true }).some((tool) => tool.function.name === "search_gifs"));
  assert.ok(!createToolService({ memory: {} }).definitions({ images: true }).some((tool) => tool.function.name === "search_gifs"));
  assert.match(await call("send_gif", { id: "invented" }), /Неизвестный/);
  const [candidate] = JSON.parse(await call("search_gifs", { query: "cat" }));
  assert.match(await call("send_image", { id: candidate.id }), /Неизвестный/);
  assert.match(await call("send_gif", { id: candidate.id }), /отправлено/);
  assert.match(await call("send_image", { id: candidate.id }), /уже отправлена/);
  assert.deepEqual(delivered, [gif]);
});
