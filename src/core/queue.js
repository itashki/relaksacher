/** @file Implementation of core/queue. */
import PQueue from "p-queue";

// One FIFO queue per assistant instance, shared by all connected adapters.
/**
 * Create a single-concurrency FIFO queue shared by all assistant adapters.
 * @returns {<T>(task: () => Promise<T>, onQueued?: (position: number) => void|Promise<void>) => Promise<T>} Enqueue function; position 1 means next.
 */
export function createRequestQueue() {
  const queue = new PQueue({ concurrency: 1 });
  /**
   * Reserve a FIFO slot and report the initial waiting position.
   * @template T
   * @param {function(): Promise<T>} task Task to execute when its slot opens.
   * @param {function(number): (void|Promise<void>)} [onQueued] Waiting notification hook.
   * @returns {Promise<T>} Task result; task failures do not block subsequent requests.
   */
  return function enqueue(task, onQueued = async () => {}) {
    const position = queue.pending + queue.size;
    // Notify immediately, but reserve the queue position synchronously.
    const notification = position > 0
      ? Promise.resolve().then(() => onQueued(position)).catch((error) => {
        console.error("Failed to display queue status:", error.message);
      }) : Promise.resolve();
    return queue.add(async () => {
      await notification;
      return task();
    });
  };
}
