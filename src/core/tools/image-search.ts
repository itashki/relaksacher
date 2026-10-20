/** @file DuckDuckGo image search with source-page links. */
import { searchImages, SafeSearchType } from "duck-duck-scrape";
import { load } from "cheerio";
import { fetchText, validatePublicUrl } from "./web-fallback.ts";

/**
 * Create image search without downloading image bytes or inferring image content.
 * @param search Injectable DuckDuckGo client.
 * @param getText Bounded fallback HTML transport.
 * @returns Up to five unique candidates.
 */
export function createImageSearch(
  search: typeof searchImages = searchImages,
  getText: (url: string) => Promise<string> = fetchText,
) {
  return async (query: string): Promise<import("../../types.ts").ImageCandidate[]> => {
    const term = String(query ?? "")
      .trim()
      .slice(0, 300);
    if (!term) return [];
    let response;
    try {
      response = await search(
        term,
        { safeSearch: SafeSearchType.MODERATE },
        {
          open_timeout: 12000,
          response_timeout: 12000,
          read_timeout: 12000,
          follow_max: 0,
          headers: {
            "user-agent":
              "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/129.0.0.0 Safari/537.36",
          },
        },
      );
      if (!Array.isArray(response?.results) || !response.results.length)
        throw new Error("No DuckDuckGo image results");
    } catch {
      const $ = load(
        await getText(`https://www.bing.com/images/search?q=${encodeURIComponent(term)}`),
      );
      const results: { image: string; url: string; title: string }[] = [];
      $("a.iusc[m]").each((_index, element) => {
        try {
          const data = JSON.parse($(element).attr("m"));
          // Bing-hosted previews avoid hotlink blocks on original websites.
          results.push({ image: data.turl || data.murl, url: data.purl, title: data.t });
        } catch {
          /* Skip malformed result metadata. */
        }
      });
      if (!results.length)
        throw new Error(
          "Image search unavailable: DuckDuckGo and Bing returned no readable results",
        );
      response = { results };
    }
    const candidates = [];
    const seen = new Set();
    for (const image of response.results) {
      try {
        const url = validatePublicUrl(image.image).href;
        const sourceUrl = validatePublicUrl(image.url).href;
        if (seen.has(url)) continue;
        seen.add(url);
        candidates.push({
          title: String(image.title || "Изображение")
            .replace(/\s+/g, " ")
            .trim()
            .slice(0, 180),
          url,
          sourceUrl,
        });
        if (candidates.length === 5) break;
      } catch {
        /* Skip malformed or non-public image/source URLs. */
      }
    }
    return candidates;
  };
}
