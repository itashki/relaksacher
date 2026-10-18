/** @file Public-page fetching and DuckDuckGo HTML fallback, without API credentials. */
import got from "got";
import { lookup } from "node:dns";
import ipaddr from "ipaddr.js";
import { load } from "cheerio";

/** @param {string} address IP address. @returns {boolean} Whether it is globally routable. */
function publicIp(address) {
  try { return ipaddr.process(address).range() === "unicast"; } catch { return false; }
}

/** @param {string|URL} input Address. @returns {URL} Valid public HTTP URL. */
export function validatePublicUrl(input) {
  const url = new URL(input);
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password ||
      host === "localhost" || host.endsWith(".localhost") ||
      (ipaddr.isValid(host) && !publicIp(host))) throw new Error("Only public HTTP(S) pages are allowed");
  return url;
}

// Validate actual resolved addresses and use those same addresses for the socket.
const http = got.extend({
  timeout: { request: 12000 }, retry: { limit: 0 }, maxRedirects: 3,
  headers: { "user-agent": "Mozilla/5.0 (compatible; Relaksacher/1.0)", accept: "text/html,text/plain" },
  hooks: { beforeRequest: [(options) => { validatePublicUrl(options.url); }],
    beforeRedirect: [(options) => { validatePublicUrl(options.url); }] },
  dnsLookup(hostname, options, callback) {
    lookup(hostname, { ...options, all: true }, (error, addresses) => {
      if (error) return callback(error);
      if (!addresses.length || addresses.some((entry) => !publicIp(entry.address))) return callback(new Error("Non-public address blocked"));
      if (options.all) callback(null, addresses);
      else callback(null, addresses[0].address, addresses[0].family);
    });
  },
});

/** @param {string} url Public address. @returns {Promise<string>} Bounded HTML/plain text. */
export async function fetchText(url) {
  validatePublicUrl(url);
  const stream = http.stream(url);
  const chunks = [];
  let size = 0;
  try {
    for await (const chunk of stream) {
      size += chunk.length;
      if (size > 2 * 1024 * 1024) throw new Error("Page exceeds 2 MB");
      chunks.push(chunk);
    }
    return Buffer.concat(chunks).toString("utf8");
  } finally { stream.destroy(); }
}

/** @param {string} text Text with irregular whitespace. @returns {string} Collapsed text. */
const clean = (text) => text.replace(/\s+/g, " ").trim();

/**
 * Build a credential-free search/page client with injectable HTML transport.
 * @param {object} [options] Dependencies.
 * @param {function(string): Promise<string>} [options.getText] Bounded public-page reader.
 * @returns {object} Ollama-compatible webSearch and webFetch operations.
 */
export function createWebFallback({ getText = fetchText } = {}) {
  return {
    /** @param {{query: string, max_results: number}} request Query. @returns {Promise<object>} Search results. */
    async webSearch({ query, max_results = 5 }) {
      const html = await getText(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`);
      const $ = load(html);
      const results = [];
      $(".result").each((_index, element) => {
        const anchor = $(element).find(".result__a").first();
        if (!anchor.length || $(element).hasClass("result--ad")) return;
        try {
          let url = new URL(anchor.attr("href"), "https://duckduckgo.com");
          if (url.hostname === "duckduckgo.com" && url.searchParams.has("uddg")) url = new URL(url.searchParams.get("uddg"));
          validatePublicUrl(url);
          if (!results.some((entry) => entry.url === url.href)) results.push({
            title: clean(anchor.text()), url: url.href, content: clean($(element).find(".result__snippet").text()),
          });
        } catch { /* Ignore malformed or non-public results. */ }
      });
      if (!results.length && !$(".no-results, .no-results__message").length) {
        throw new Error("DuckDuckGo returned no readable results (possible CAPTCHA or changed markup)");
      }
      return { results: results.slice(0, Math.min(8, Math.max(1, max_results))) };
    },
    /** @param {{url: string}} request Public page. @returns {Promise<object>} Extracted page data. */
    async webFetch({ url }) {
      validatePublicUrl(url);
      const $ = load(await getText(url));
      $("script,style,noscript,nav,footer,header,form,svg").remove();
      const links = [];
      $("a[href]").each((_index, element) => {
        if (links.length >= 10) return;
        try {
          const href = validatePublicUrl(new URL($(element).attr("href"), url)).href;
          if (!links.includes(href)) links.push(href);
        } catch { /* Ignore unsupported links. */ }
      });
      const root = $("main,article").first();
      return { title: clean($("title").text()), content: clean((root.length ? root : $("body")).text()).slice(0, 12000), links };
    },
  };
}

/**
 * Prefer Ollama; retry through the independent fallback on failure or empty output.
 * @param {object|null} primary Ollama search client.
 * @param {object|null} fallback Scraper client.
 * @param {number} [timeoutMs=12000] Maximum wait for the primary before fallback.
 * @returns {object|null} Combined web client.
 */
export function createWebClient(primary, fallback, timeoutMs = 12000) {
  if (!primary) return fallback;
  if (!fallback) return primary;
  return Object.fromEntries(["webSearch", "webFetch"].map((method) => [method, async (request) => {
    let timer;
    try {
      const result = await Promise.race([
        primary[method](request),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("Ollama web timeout")), timeoutMs); }),
      ]);
      if (method === "webSearch" ? !result.results?.length : !result.content?.trim()) throw new Error("Empty Ollama web response");
      return result;
    } catch {
      console.warn(`Ollama ${method} unavailable; using web fallback`);
      return fallback[method](request);
    } finally { clearTimeout(timer); }
  }]));
}
