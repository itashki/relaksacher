import type { Message } from "ollama";
const MAX_BYTES = 10 * 1024 * 1024;

/**
 * Download a trusted-host image with timeout, byte limit and signature validation.
 * @param url HTTPS image address.
 * @returns JPEG/PNG/WebP bytes encoded as base64.
 * @throws {Error} When downloading or validation fails.
 */
export async function downloadImage(url: string, { fetchImpl = fetch, allowedHosts }: { fetchImpl?: import("../types.ts").HttpFetch; allowedHosts: string[]; }) {
  const parsed = new URL(url);
  if (parsed.protocol !== "https:" || !allowedHosts.includes(parsed.hostname)) throw new Error("Invalid image host");
  const response = await fetchImpl(url, { signal: AbortSignal.timeout(30000), redirect: "error" });
  if (!response.ok) throw new Error("Image download failed");
  if (Number(response.headers.get("content-length")) > MAX_BYTES) {
    await response.body?.cancel();
    throw new Error("Image exceeds 10 MB");
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > MAX_BYTES) throw new Error("Image exceeds 10 MB");
    chunks.push(chunk);
  }
  const data = Buffer.concat(chunks);
  const valid = data.subarray(0, 3).equals(Buffer.from([255, 216, 255])) ||
    data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ||
    (data.toString("ascii", 0, 4) === "RIFF" && data.toString("ascii", 8, 12) === "WEBP");
  if (!valid) throw new Error("Expected JPEG, PNG or WebP");
  return data.toString("base64");
}

/**
 * Attach at most four images, newest messages first; annotate omissions/failures.
 * @param conversation Messages mutated in place.
 * @param sources Image URLs or file ids aligned with message indexes.
 * @param loadImage Resolve a source to base64.
 * @returns The same conversation array.
 */
export async function attachImages(conversation: Message[], sources: string[][], loadImage: (arg0: string) => Promise<string>) {
  let remaining = 4;
  // Prefer the current request, then the newest referenced pictures.
  for (let index = conversation.length - 1; index >= 0; index--) {
    const files = sources[index] ?? [];
    if (!files.length) continue;
    const images = [];
    for (const file of files) {
      if (!remaining) {
        conversation[index].content += "\n[Часть изображений не передана: лимит 4 на запрос.]";
        break;
      }
      remaining--;
      try { images.push(await loadImage(file)); }
      catch { conversation[index].content += "\n[Изображение не загружено. Не делай выводов о его содержимом; попроси прислать JPEG, PNG или WebP до 10 МБ повторно.]"; }
    }
    if (images.length) conversation[index].images = images;
  }
  return conversation;
}
