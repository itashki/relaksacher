/** @file Image search with source/author/license metadata from Wikimedia Commons. */
import { load } from "cheerio";
import { fetchText } from "./web-fallback.js";

/**
 * Create a public image search operation. This does not download image bytes.
 * @param {function(string): Promise<string>} [getText] Bounded JSON transport.
 * @returns {function(string): Promise<Array<object>>} Up to five image candidates.
 */
export function createImageSearch(getText = fetchText) {
  return async (query) => {
    const params = new URLSearchParams({ action: "query", format: "json", generator: "search",
      gsrsearch: query.slice(0, 300), gsrnamespace: "6", gsrlimit: "5", prop: "imageinfo",
      iiprop: "url|mime|extmetadata", iiurlwidth: "1280", iiextmetadatafilter: "Artist|LicenseShortName", });
    const result = JSON.parse(await getText(`https://commons.wikimedia.org/w/api.php?${params}`));
    if (result.error) throw new Error("Image search provider failed");
    const plain = (html) => load(String(html ?? "")).text().replace(/\s+/g, " ").trim().slice(0, 180);
    return Object.values(result.query?.pages ?? {}).sort((a, b) => (a.index ?? 0) - (b.index ?? 0)).flatMap((page) => {
      const image = page.imageinfo?.[0];
      if (!image || !["image/jpeg", "image/png", "image/webp"].includes(image.mime)) return [];
      const url = image.thumburl || image.url;
      const sourceUrl = image.descriptionurl;
      try {
        if (new URL(url).protocol !== "https:" || !["upload.wikimedia.org", "thumb.wikimedia.org"].includes(new URL(url).hostname) ||
            new URL(sourceUrl).protocol !== "https:" || new URL(sourceUrl).hostname !== "commons.wikimedia.org") return [];
      } catch { return []; }
      return [{ title: page.title.replace(/^File:/, "").slice(0, 180), url, sourceUrl,
        author: plain(image.extmetadata?.Artist?.value), license: plain(image.extmetadata?.LicenseShortName?.value) }];
    });
  };
}
