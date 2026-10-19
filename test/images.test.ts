/** @file Regression coverage for images behavior and its external boundaries. */
import { expect, test } from "bun:test";
import { attachImages, downloadImage } from "../src/adapters/images.ts";
import { guardContext } from "../src/core/context.ts";

test("downloads valid image bytes as base64 and rejects non-images and untrusted hosts", async () => {
  const jpeg = new Uint8Array([255, 216, 255, 0]);
  const options = {
    allowedHosts: ["cdn.discordapp.com"],
    fetchImpl: async () => new Response(jpeg),
  };
  expect(await downloadImage("https://cdn.discordapp.com/image", options)).toBe(jpeg.toBase64());
  await expect(downloadImage("https://localhost/image", options)).rejects.toThrow(/host/);
  await expect(
    downloadImage("https://cdn.discordapp.com/image", {
      ...options,
      fetchImpl: async () => new Response("not an image"),
    }),
  ).rejects.toThrow(/Expected/);
  await expect(
    downloadImage("https://cdn.discordapp.com/image", {
      ...options,
      fetchImpl: async () =>
        new Response(jpeg, { headers: { "content-length": String(11 * 1024 * 1024) } }),
    }),
  ).rejects.toThrow(/10 MB/);
});

test("limits images, prioritizes current request and reports download failures", async () => {
  const conversation: import("ollama").Message[] = [
    { role: "user", content: "older" },
    { role: "user", content: "current" },
  ];
  await attachImages(conversation, [["old"], ["a", "b", "c", "d", "e"]], async (id) => {
    if (id === "b") throw new Error("secret URL");
    return id;
  });
  expect(conversation[1].images).toStrictEqual(["a", "c", "d"]);
  expect(conversation[1].content).toMatch(/не загружено/);
  expect(conversation[1].content).toMatch(/лимит 4/);
  expect(conversation[1].content).not.toMatch(/secret/);
  expect(conversation[0].images).toBe(undefined);
});

test("context budgeting does not count base64 as text tokens", () => {
  const messages: import("ollama").Message[] = [
    { role: "system", content: "rules" },
    { role: "user", content: "describe", images: ["A".repeat(1000000)] },
  ];
  expect(guardContext(messages, [], 16384).trimmed).toBe(false);
  expect(messages[1].images[0].length).toBe(1000000);
});
