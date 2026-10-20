import type { ImageCandidate, RequestContext } from "../../src/types.ts";
/** @file Image search parsing and session-scoped image delivery. */
import { expect, test } from "bun:test";
import { createImageSearch } from "../support/fixtures.ts";
import { createToolService } from "../support/fixtures.ts";

test("DuckDuckGo image search normalizes results and rejects private URLs and duplicates", async () => {
  const search = createImageSearch(async (query, options, transport) => {
    expect(query).toBe("elephant");
    expect(typeof options.safeSearch).toBe("number");
    expect(transport.response_timeout).toBe(12000);
    return {
      results: [
        {
          title: "Elephant",
          image: "https://images.example.org/elephant.jpg",
          url: "https://example.org/elephant",
        },
        {
          title: "Duplicate",
          image: "https://images.example.org/elephant.jpg",
          url: "https://example.org/other",
        },
        { image: "http://127.0.0.1/image.jpg", url: "https://example.org/" },
        { image: "https://images.example.org/private.jpg", url: "http://localhost/" },
        { image: "javascript:alert(1)", url: "https://example.org/" },
      ],
    };
  });
  expect(await search("  elephant  ")).toStrictEqual([
    {
      title: "Elephant",
      url: "https://images.example.org/elephant.jpg",
      sourceUrl: "https://example.org/elephant",
    },
  ]);
});

test("image search limits results, skips blank queries and surfaces provider errors", async () => {
  let calls = 0;
  const search = createImageSearch(async () => {
    calls++;
    return {
      results: Array.from({ length: 10 }, (_, i) => ({
        title: "Image",
        image: `https://example.org/${i}.jpg`,
        url: "https://example.org/",
      })),
    };
  });
  expect(await search(" ")).toStrictEqual([]);
  expect(calls).toBe(0);
  expect((await search("cats")).length).toBe(5);
  await expect(
    createImageSearch(
      async () => {
        throw new Error("blocked");
      },
      async () => {
        throw new Error("blocked");
      },
    )("cats"),
  ).rejects.toThrow(/blocked/);
  await expect(
    createImageSearch(
      async () => ({}),
      async () => "<html></html>",
    )("cats"),
  ).rejects.toThrow(/Image search unavailable/);
});

test("image delivery accepts only searched ids and limits sends to one per session", async () => {
  const delivered: ImageCandidate[] = [];
  const image = {
    title: "Elephant",
    url: "https://upload.wikimedia.org/elephant.jpg",
    sourceUrl: "https://commons.wikimedia.org/wiki/File:Elephant.jpg",
  };
  const service = createToolService({ memory: {}, imageSearch: async () => [image] });
  const context: RequestContext = {
    imageState: { candidates: new Map(), sent: false },
    sendImage: async (candidate) => {
      delivered.push(candidate);
    },
  };
  const call = (name: string, args: Record<string, unknown>) =>
    service.runTool({ function: { name, arguments: args } }, context);
  expect(await call("send_image", { id: "invented" })).toMatch(/Неизвестный/);
  const [candidate] = JSON.parse(await call("search_images", { query: "elephant" }));
  expect(await call("send_image", { id: candidate.id })).toMatch(/отправлено/);
  expect(await call("send_image", { id: candidate.id })).toMatch(/уже отправлена/);
  expect(delivered).toStrictEqual([image]);
  expect(!service.definitions({}).some((tool) => tool.function.name === "send_image")).toBeTruthy();
  expect(
    service.definitions({ images: true }).some((tool) => tool.function.name === "send_image"),
  ).toBeTruthy();
});

test("Bing image fallback is used when DuckDuckGo fails", async () => {
  const metadata = JSON.stringify({
    turl: "https://ts1.mm.bing.net/cat.jpg",
    murl: "https://example.org/cat.jpg",
    purl: "https://example.org/cats",
    t: "Cat",
  });
  const search = createImageSearch(
    async () => {
      throw new Error("blocked");
    },
    async (url) => {
      expect(new URL(url).hostname).toBe("www.bing.com");
      return `<a class="iusc" m='${metadata}'></a>`;
    },
  );
  expect(await search("cat")).toStrictEqual([
    { title: "Cat", url: "https://ts1.mm.bing.net/cat.jpg", sourceUrl: "https://example.org/cats" },
  ]);
});
