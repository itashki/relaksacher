import PQueue from "p-queue";

// One FIFO queue per assistant instance, shared by all connected adapters.
export function createRequestQueue() {
  const queue = new PQueue({ concurrency: 1 });
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
