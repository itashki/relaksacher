/** @file Adapt grammY requests with deadlines, bounded retries and platform-hosted image downloads. */
import { downloadVoice } from "./voice.ts";
import { Api, InputFile, HttpError, GrammyError } from "grammy";
import { autoRetry } from "@grammyjs/auto-retry";
import pRetry from "p-retry";
import { downloadImage } from "./images.ts";

/**
 * Wrap grammY with native signal bridging, bounded retries and sanitized errors.
 * @param token Telegram credential; never include it in logs.
 * @param fetchImpl Injectable transport, also used for downloads.
 * @returns Callable API with an image loader.
 */
export function createTelegramApi(
  token: string,
  fetchImpl: import("../types.ts").HttpFetch = fetch,
  { timeoutMs = 60000 }: { timeoutMs?: number } = {},
): import("../types.ts").TelegramApi {
  const client = new Api(token, {
    // grammY uses a signal implementation that Node's native fetch rejects.
    // Bridge cancellation through a native controller at the transport boundary.
    fetch: async (url: string | URL, options?: RequestInit) => {
      const controller = new AbortController();
      const abort = () => controller.abort();
      const source = options?.signal;
      if (source?.aborted) abort();
      else source?.addEventListener("abort", abort, { once: true });
      try {
        return await fetchImpl(url, { ...options, signal: controller.signal });
      } finally {
        source?.removeEventListener("abort", abort);
      }
    },
    timeoutSeconds: timeoutMs / 1000,
    sensitiveLogs: false,
  });
  // Retry explicit rate-limit responses. Network failures on sends are ambiguous:
  // only retry edits automatically to avoid accidentally sending duplicates.
  client.config.use(
    autoRetry({
      maxRetryAttempts: 1,
      maxDelaySeconds: 30,
      rethrowHttpErrors: true,
      rethrowInternalServerErrors: true,
    }),
  );
  /**
   * Call Telegram, retrying safe operations while avoiding duplicate sends.
   * @param method Telegram API method.
   * @param payload Raw API parameters.
   * @param signal Native or compatible external cancellation signal.
   * @returns Telegram result.
   * @throws {Error} Sanitized error with code, transient and retryAfter metadata.
   */
  const request = async (
    method: string,
    payload: { [x: string]: any } = {},
    signal?: import("../types.ts").CancellationSignal,
  ) => {
    // Runner also supplies a non-native signal. Bridge it instead of passing
    // it to AbortSignal.any, which checks the native signal brand.
    const controller = new AbortController();
    const abort = () => controller.abort();
    if (signal?.aborted) abort();
    else signal?.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(abort, timeoutMs);
    timer.unref?.();
    const deadline = controller.signal;
    try {
      const prepared: Record<string, unknown> =
        payload.document instanceof Blob
          ? {
              ...payload,
              document: new InputFile(
                new Uint8Array(await payload.document.arrayBuffer()),
                "thinking.md",
              ),
            }
          : { ...payload };
      if (payload.voice instanceof Blob)
        prepared.voice = new InputFile(
          new Uint8Array(await payload.voice.arrayBuffer()),
          "voice.ogg",
        );
      // grammY binds an empty payload for getMe, so its only argument is signal.
      const call = () =>
        method === "getMe"
          ? client.getMe(deadline as unknown as Parameters<typeof client.getMe>[0])
          : (
              client.raw as unknown as Record<
                string,
                (payload: Record<string, unknown>, signal: AbortSignal) => Promise<unknown>
              >
            )[method](prepared, deadline);
      return await pRetry(call, {
        retries: ["editMessageText", "getMe"].includes(method) ? 1 : 0,
        minTimeout: 500,
        maxTimeout: 1000,
        signal: deadline,
        shouldRetry: ({ error }) =>
          error instanceof HttpError || (error instanceof GrammyError && error.error_code >= 500),
      });
    } catch (cause) {
      // Keep token-bearing URLs, payloads, and underlying fetch errors out of logs.
      const description =
        cause instanceof GrammyError
          ? cause.description
          : deadline.aborted
            ? "request timed out or cancelled"
            : cause instanceof HttpError
              ? "connection failed"
              : "client request failed";
      const error = new Error(`Telegram ${method}: ${description}`) as Error & {
        code?: number;
        error_code?: number;
        parameters?: { retry_after?: number };
        transient?: boolean;
        retryAfter?: number;
      };
      error.code = error.error_code = cause instanceof GrammyError ? cause.error_code : undefined;
      error.parameters = cause instanceof GrammyError ? cause.parameters : undefined;
      error.transient =
        !signal?.aborted &&
        (cause instanceof HttpError || deadline.aborted || error.code === 429 || error.code >= 500);
      error.retryAfter = error.parameters?.retry_after;
      throw error;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
    }
  };
  /**
   * Resolve a Telegram file id and validate the bounded image download.
   * @param fileId Telegram file identifier.
   * @returns Base64 image content.
   * @throws {Error} When metadata, size, download or image validation fails.
   */
  request.downloadImage = async (fileId: string) => {
    const file = (await request("getFile", { file_id: fileId })) as import("@grammyjs/types").File;
    if (file.file_size > 10 * 1024 * 1024 || !file.file_path || file.file_path.includes(".."))
      throw new Error("Invalid or oversized image");
    try {
      return await downloadImage(`https://api.telegram.org/file/bot${token}/${file.file_path}`, {
        fetchImpl,
        allowedHosts: ["api.telegram.org"],
      });
    } catch {
      throw new Error("Telegram image download failed");
    }
  };
  request.downloadVoice = async (fileId: string) => {
    const file = (await request("getFile", { file_id: fileId })) as import("@grammyjs/types").File;
    if (
      file.file_size > 20 * 1024 * 1024 ||
      !file.file_path ||
      !/^[\w/.-]+$/.test(file.file_path) ||
      file.file_path.includes("..")
    )
      throw new Error("Invalid voice file");
    try {
      return await downloadVoice(`https://api.telegram.org/file/bot${token}/${file.file_path}`, {
        fetchImpl,
        allowedHosts: ["api.telegram.org"],
      });
    } catch {
      throw new Error("Telegram voice download failed");
    }
  };
  return request;
}
