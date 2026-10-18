/** @file KLIPY GIF search using its Tenor-compatible API. */
import { fetchText, validatePublicUrl } from "./web-fallback.js";

/**
 * Create optional GIF search; credentials stay outside model-visible results/errors.
 * @param {object} options Provider settings.
 * @param {string} [options.apiKey] KLIPY API key; absent disables GIF tools.
 * @param {typeof fetchText} [options.getText] Bounded JSON transport.
 * @returns {function(string): Promise<import("../types.js").ImageCandidate[]>|null} Search operation.
 */
export function createGifSearch({ apiKey, getText = fetchText } = {}) {
  if (!apiKey?.trim()) return null;
  return async (query) => {
    const term = String(query ?? "").trim().slice(0, 300);
    if (!term) return [];
    try {
      const params = new URLSearchParams({ key: apiKey, q: term, limit: "5",
        media_filter: "tinygif,tinymp4", contentfilter: "medium", locale: "ru_RU" });
      const response = JSON.parse(await getText(`https://api.klipy.com/v2/search?${params}`));
      if (!Array.isArray(response.results)) throw new Error("Invalid response");
      const candidates = [];
      const seen = new Set();
      for (const entry of response.results) {
        try {
          const media = entry.media_formats?.tinygif;
          if (!media?.url || media.size > 10 * 1024 * 1024) continue;
          const url = validatePublicUrl(media.url);
          const source = validatePublicUrl(entry.itemurl || entry.url);
          if (url.protocol !== "https:" || !(url.hostname === "static.klipy.com" || url.hostname.endsWith(".static.klipy.com")) ||
              source.protocol !== "https:" || !(source.hostname === "klipy.com" || source.hostname === "www.klipy.com") || seen.has(url.href)) continue;
          seen.add(url.href);
          candidates.push({ title: String(entry.title || entry.content_description || "GIF").slice(0, 180),
            url: url.href, sourceUrl: source.href, kind: "gif", provider: "KLIPY" });
          if (candidates.length === 5) break;
        } catch { /* Skip malformed or unexpected provider addresses. */ }
      }
      return candidates;
    } catch {
      // Transport errors may contain the API key in their URL; never propagate them.
      throw new Error("KLIPY GIF search failed; check API key, limits and connectivity");
    }
  };
}
