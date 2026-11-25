/** @file Download platform-hosted videos with a deadline, a streaming byte limit and an MP4/MOV signature check; extract their audio. */
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";

const MAX_BYTES = 20 * 1024 * 1024;

/**
 * Fetch at most 20 MiB of MP4/MOV video from an explicitly trusted HTTPS host without following redirects.
 * @param url HTTPS file address without credentials.
 * @param options Host allowlist and an optional injected fetch.
 * @returns Blob of type `video/mp4` whose bytes 4-8 are the `ftyp` box marker.
 * @throws {Error} Always the sanitized message "Video download failed"; transport details are never forwarded.
 */
export async function downloadVideo(
  url: string,
  {
    allowedHosts,
    fetchImpl = fetch,
  }: { allowedHosts: string[]; fetchImpl?: import("../../types.ts").HttpFetch },
): Promise<Blob> {
  try {
    const address = new URL(url);
    if (
      address.protocol !== "https:" ||
      !allowedHosts.includes(address.hostname) ||
      address.username ||
      address.password
    )
      throw new Error("Invalid video host");
    const response = await fetchImpl(url, {
      signal: AbortSignal.timeout(60000),
      redirect: "error",
    });
    if (!response.ok || Number(response.headers.get("content-length")) > MAX_BYTES) {
      await response.body?.cancel();
      throw new Error("Video download failed");
    }
    const chunks: Uint8Array[] = [];
    let size = 0;
    for await (const chunk of response.body) {
      size += chunk.length;
      if (size > MAX_BYTES) throw new Error("Video file too large");
      chunks.push(chunk);
    }
    const data = new Uint8Array(Bun.concatArrayBuffers(chunks));
    if (data.length < 12 || new TextDecoder().decode(data.subarray(4, 8)) !== "ftyp")
      throw new Error("Expected MP4 or MOV video");
    return new Blob([data], { type: "video/mp4" });
  } catch {
    throw new Error("Video download failed");
  }
}

/**
 * Extract the audio track of a video as mono 16 kHz Ogg/Opus for speech recognition.
 * Goes through a temp file because MP4 may need seeking.
 * @param video MP4/MOV blob.
 * @returns Ogg blob, or undefined when ffmpeg fails (no audio track, bad file).
 */
export async function extractAudio(video: Blob): Promise<Blob | undefined> {
  const path = `${tmpdir()}/relaksacher-${crypto.randomUUID()}.mp4`;
  try {
    await Bun.write(path, video);
    const ffmpeg = Bun.spawn(
      [
        "ffmpeg",
        "-nostdin",
        "-loglevel",
        "error",
        "-i",
        path,
        "-vn",
        "-ac",
        "1",
        "-ar",
        "16000",
      ].concat(["-c:a", "libopus", "-f", "ogg", "pipe:1"]),
      { stdout: "pipe", stderr: "ignore", timeout: 60000 },
    );
    const audio = await new Response(ffmpeg.stdout).blob();
    return (await ffmpeg.exited) === 0 && audio.size ? audio : undefined;
  } catch {
    return undefined;
  } finally {
    await rm(path, { force: true });
  }
}
