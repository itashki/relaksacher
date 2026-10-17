/** @file Implementation of adapters/telegram-api. */
import { Api, InputFile, HttpError, GrammyError } from "grammy";
import { autoRetry } from "@grammyjs/auto-retry";
import pRetry from "p-retry";
import { downloadImage } from "./images.js";

/**
 * Wrap grammY with native signal bridging, bounded retries and sanitized errors.
 * @param {string} token Telegram credential; never include it in logs.
 * @param {typeof fetch} [fetchImpl=fetch] Injectable transport, also used for downloads.
 * @param {object} [options] Request policy.
 * @param {number} [options.timeoutMs=60000] Whole-request deadline in milliseconds.
 * @returns {import("../types.js").TelegramApi} Callable API with an image loader.
 */
export function createTelegramApi(token, fetchImpl = fetch, { timeoutMs = 60000 } = {}) {
  const client = new Api(token, {
    // grammY uses a signal implementation that Node's native fetch rejects.
    // Bridge cancellation through a native controller at the transport boundary.
    fetch: async (url, options) => {
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
    }, timeoutSeconds: timeoutMs / 1000, sensitiveLogs: false,
  });
  // Retry explicit rate-limit responses. Network failures on sends are ambiguous:
  // only retry edits automatically to avoid accidentally sending duplicates.
  client.config.use(autoRetry({
    maxRetryAttempts: 1, maxDelaySeconds: 30,
    rethrowHttpErrors: true, rethrowInternalServerErrors: true,
  }));
  /**
   * Call Telegram, retrying safe operations while avoiding duplicate sends.
   * @param {string} method Telegram API method.
   * @param {Object<string, *>} [payload] Raw API parameters.
   * @param {AbortSignal} [signal] Native or compatible external cancellation signal.
   * @returns {Promise<*>} Telegram result.
   * @throws {Error} Sanitized error with code, transient and retryAfter metadata.
   */
  const request = async (method, payload = {}, signal) => {
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
      const prepared = payload.document instanceof Blob
        ? { ...payload, document: new InputFile(new Uint8Array(await payload.document.arrayBuffer()), "thinking.md") }
        : payload;
      // grammY binds an empty payload for getMe, so its only argument is signal.
      const call = () => method === "getMe"
        ? client.getMe(deadline)
        : client.raw[method](prepared, deadline);
      return await pRetry(call, {
        retries: ["editMessageText", "getMe"].includes(method) ? 1 : 0,
        minTimeout: 500, maxTimeout: 1000, signal: deadline,
        shouldRetry: ({ error }) => error instanceof HttpError ||
          (error instanceof GrammyError && error.error_code >= 500),
      });
    } catch (cause) {
      // Keep token-bearing URLs, payloads, and underlying fetch errors out of logs.
      const description = cause instanceof GrammyError ? cause.description :
        deadline.aborted ? "request timed out or cancelled" :
          cause instanceof HttpError ? "connection failed" : "client request failed";
      const error = new Error(`Telegram ${method}: ${description}`);
      error.code = error.error_code = cause instanceof GrammyError ? cause.error_code : undefined;
      error.parameters = cause instanceof GrammyError ? cause.parameters : undefined;
      error.transient = !signal?.aborted && (cause instanceof HttpError || deadline.aborted || error.code === 429 || error.code >= 500);
      error.retryAfter = error.parameters?.retry_after;
      throw error;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
    }
  };
  /**
   * Resolve a Telegram file id and validate the bounded image download.
   * @param {string} fileId Telegram file identifier.
   * @returns {Promise<string>} Base64 image content.
   * @throws {Error} When metadata, size, download or image validation fails.
   */
  request.downloadImage = async (fileId) => {
    const file = await request("getFile", { file_id: fileId });
    if (file.file_size > 10 * 1024 * 1024 || !file.file_path || file.file_path.includes("..")) throw new Error("Invalid or oversized image");
    try {
      return await downloadImage(`https://api.telegram.org/file/bot${token}/${file.file_path}`, {
        fetchImpl, allowedHosts: ["api.telegram.org"],
      });
    } catch { throw new Error("Telegram image download failed"); }
  };
  return request;
}
