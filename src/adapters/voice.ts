/** @file Download platform-hosted voice recordings with a deadline and a streaming byte limit. */

/** Fetch at most 20 MiB from an explicitly trusted HTTPS host, without following redirects.
 * Throws on HTTP failures, empty files or excessive size. Never forwards transport errors. */
export async function downloadVoice(
  url: string,
  {
    allowedHosts,
    fetchImpl = fetch,
  }: { allowedHosts: string[]; fetchImpl?: import("../types.ts").HttpFetch },
): Promise<Blob> {
  try {
    const address = new URL(url);
    if (
      address.protocol !== "https:" ||
      !allowedHosts.includes(address.hostname) ||
      address.username ||
      address.password
    )
      throw new Error("Invalid voice host");
    const response = await fetchImpl(url, {
      signal: AbortSignal.timeout(60000),
      redirect: "error",
    });
    const limit = 20 * 1024 * 1024;
    if (!response.ok || Number(response.headers.get("content-length")) > limit) {
      await response.body?.cancel();
      throw new Error("Voice download failed");
    }
    const chunks: Uint8Array[] = [];
    let size = 0;
    for await (const chunk of response.body) {
      size += chunk.length;
      if (size > limit) throw new Error("Voice file too large");
      chunks.push(chunk);
    }
    if (!size) throw new Error("Empty voice file");
    return new Blob([Bun.concatArrayBuffers(chunks)], { type: "audio/ogg" });
  } catch {
    throw new Error("Voice download failed");
  }
}
