import test from "node:test";
import assert from "node:assert/strict";
import { attachImages, downloadImage } from "../src/adapters/images.js";
import { guardContext } from "../src/core/context.js";

test("downloads valid image bytes as base64 and rejects non-images and untrusted hosts", async () => {
  const jpeg = Buffer.from([255, 216, 255, 0]);
  const options = { allowedHosts: ["cdn.discordapp.com"], fetchImpl: async () => new Response(jpeg) };
  assert.equal(await downloadImage("https://cdn.discordapp.com/image", options), jpeg.toString("base64"));
  await assert.rejects(downloadImage("https://localhost/image", options), /host/);
  await assert.rejects(downloadImage("https://cdn.discordapp.com/image", {
    ...options, fetchImpl: async () => new Response("not an image"),
  }), /Expected/);
  await assert.rejects(downloadImage("https://cdn.discordapp.com/image", {
    ...options, fetchImpl: async () => new Response(jpeg, { headers: { "content-length": String(11 * 1024 * 1024) } }),
  }), /10 MB/);
});

test("limits images, prioritizes current request and reports download failures", async () => {
  const conversation = [{ role: "user", content: "older" }, { role: "user", content: "current" }];
  await attachImages(conversation, [["old"], ["a", "b", "c", "d", "e"]], async (id) => {
    if (id === "b") throw new Error("secret URL");
    return id;
  });
  assert.deepEqual(conversation[1].images, ["a", "c", "d"]);
  assert.match(conversation[1].content, /не загружено/);
  assert.match(conversation[1].content, /лимит 4/);
  assert.doesNotMatch(conversation[1].content, /secret/);
  assert.equal(conversation[0].images, undefined);
});

test("context budgeting does not count base64 as text tokens", () => {
  const messages = [{ role: "system", content: "rules" },
    { role: "user", content: "describe", images: ["A".repeat(1000000)] }];
  assert.equal(guardContext(messages, [], 16384).trimmed, false);
  assert.equal(messages[1].images[0].length, 1000000);
});
