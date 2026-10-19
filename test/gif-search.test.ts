import type { ImageCandidate, RequestContext } from "../src/types.ts";
/** @file GIF provider normalization, credential handling and tool delivery. */
import { expect, test } from "bun:test";
import { createGifSearch } from "../src/core/gif-search.ts";
import { createToolService } from "./fixtures.ts";

test("KLIPY search validates media, caps results and does not expose credentials", async () => {
  expect(createGifSearch()).toBe(null);
  const search = createGifSearch({
    apiKey: "secret",
    getText: async (url) => {
      const params = new URL(url).searchParams;
      expect(params.get("key")).toBe("secret");
      expect(params.get("q")).toBe("cat");
      return JSON.stringify({
        results: [
          {
            title: "Cat",
            itemurl: "https://klipy.com/gifs/cat",
            media_formats: { tinygif: { url: "https://static.klipy.com/cat.gif", size: 100 } },
          },
          {
            itemurl: "https://klipy.com/gifs/private",
            media_formats: { tinygif: { url: "http://127.0.0.1/a.gif" } },
          },
          {
            itemurl: "https://klipy.com/gifs/huge",
            media_formats: {
              tinygif: { url: "https://static.klipy.com/huge.gif", size: 20000000 },
            },
          },
        ],
      });
    },
  });
  expect(await search("cat")).toStrictEqual([
    {
      title: "Cat",
      url: "https://static.klipy.com/cat.gif",
      sourceUrl: "https://klipy.com/gifs/cat",
      kind: "gif" as const,
      provider: "KLIPY",
    },
  ]);
  await expect(
    createGifSearch({
      apiKey: "secret",
      getText: async () => {
        throw new Error("https://api.klipy.com/?key=secret");
      },
    })("cat"),
  ).rejects.toMatchObject({ message: expect.not.stringContaining("secret") });
});

test("GIF tools are opt-in and share the image delivery limit", async () => {
  const gif = {
    title: "Cat",
    url: "https://static.klipy.com/cat.gif",
    sourceUrl: "https://klipy.com/gifs/cat",
    kind: "gif" as const,
  };
  const delivered: ImageCandidate[] = [];
  const service = createToolService({ memory: {}, gifSearch: async () => [gif] });
  const context: RequestContext = {
    imageState: { candidates: new Map(), sent: false },
    sendImage: async (image) => {
      delivered.push(image);
    },
  };
  const call = (name: string, args: Record<string, unknown>) =>
    service.runTool({ function: { name, arguments: args } }, context);
  expect(
    service.definitions({ images: true }).some((tool) => tool.function.name === "search_gifs"),
  ).toBeTruthy();
  expect(
    !createToolService({ memory: {} })
      .definitions({ images: true })
      .some((tool) => tool.function.name === "search_gifs"),
  ).toBeTruthy();
  expect(await call("send_gif", { id: "invented" })).toMatch(/Неизвестный/);
  const [candidate] = JSON.parse(await call("search_gifs", { query: "cat" }));
  expect(await call("send_image", { id: candidate.id })).toMatch(/Неизвестный/);
  expect(await call("send_gif", { id: candidate.id })).toMatch(/отправлено/);
  expect(await call("send_image", { id: candidate.id })).toMatch(/уже отправлена/);
  expect(delivered).toStrictEqual([gif]);
});
