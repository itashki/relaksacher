/** @file Image search parsing and session-scoped image delivery. */
import test from "node:test";
import assert from "node:assert/strict";
import { createImageSearch } from "../src/core/image-search.js";
import { createToolService } from "../src/core/tools.js";

test("image search accepts public Commons images with readable attribution", async () => {
  const search = createImageSearch(async (url) => {
    assert.equal(new URL(url).searchParams.get("gsrsearch"), "elephant");
    return JSON.stringify({ query: { pages: {
      1: { title: "File:Elephant.jpg", imageinfo: [{ mime: "image/jpeg", url: "https://upload.wikimedia.org/elephant.jpg",
        thumburl: "https://thumb.wikimedia.org/elephant-1280px.jpg",
        descriptionurl: "https://commons.wikimedia.org/wiki/File:Elephant.jpg",
        extmetadata: { Artist: { value: "<b>Photographer</b>" }, LicenseShortName: { value: "CC BY-SA" } } }] },
      2: { title: "File:Private.jpg", imageinfo: [{ mime: "image/jpeg", url: "http://localhost/image.jpg", descriptionurl: "https://commons.wikimedia.org/" }] },
    } } });
  });
  const result = await search("elephant");
  assert.equal(result.length, 1);
  assert.equal(result[0].url, "https://thumb.wikimedia.org/elephant-1280px.jpg");
  assert.equal(result[0].author, "Photographer");
  assert.equal(result[0].license, "CC BY-SA");
});

test("image delivery accepts only searched ids and limits sends to one per session", async () => {
  const delivered = [];
  const image = { title: "Elephant", url: "https://upload.wikimedia.org/elephant.jpg", sourceUrl: "https://commons.wikimedia.org/wiki/File:Elephant.jpg" };
  const service = createToolService({ memory: {}, imageSearch: async () => [image] });
  const context = { imageState: { candidates: new Map(), sent: false }, sendImage: async (candidate) => delivered.push(candidate) };
  const call = (name, args) => service.runTool({ function: { name, arguments: args } }, context);
  assert.match(await call("send_image", { id: "invented" }), /Неизвестный/);
  const [candidate] = JSON.parse(await call("search_images", { query: "elephant" }));
  assert.match(await call("send_image", { id: candidate.id }), /отправлена/);
  assert.match(await call("send_image", { id: candidate.id }), /уже отправлена/);
  assert.deepEqual(delivered, [image]);
  assert.ok(!service.definitions({}).some((tool) => tool.function.name === "send_image"));
  assert.ok(service.definitions({ images: true }).some((tool) => tool.function.name === "send_image"));
});
