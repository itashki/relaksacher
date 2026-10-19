/** @file Serialize foreground and background inference through a shared priority queue. */
import PQueue from "p-queue";

// One FIFO queue per assistant instance, shared by all connected adapters.
/**
 * Create a single-concurrency FIFO queue shared by all assistant adapters.
 * @returns Enqueue function; position 1 means next.
 */
export function createRequestQueue() {
  const queue = new PQueue({ concurrency: 1 });
  /**
   * Reserve a FIFO slot and report the initial waiting position.
   * @param task Task to execute when its slot opens.
   * @param onQueued Waiting notification hook.
   * @param options Negative priorities defer background work.
   * @returns Task result; task failures do not block subsequent requests.
   */
  return function enqueue<T>(
    task: () => Promise<T>,
    onQueued: (arg0: number) => void | Promise<void> = async () => {},
    { priority = 0 }: { priority?: number } = {},
  ): Promise<T> {
    const position = queue.pending + queue.size;
    // Notify immediately, but reserve the queue position synchronously.
    const notification =
      position > 0
        ? Promise.resolve()
            .then(() => onQueued(position))
            .catch((error) => {
              console.error("Failed to display queue status:", error.message);
            })
        : Promise.resolve();
    return queue.add(
      async () => {
        await notification;
        return task();
      },
      { priority },
    );
  };
}
