/**
 * @file Background memory observer: buffers group messages and extracts at most one fact per
 * batch through the shared low-priority generation queue, with per-room rate limiting.
 */

type ObservedMessage = { id: string; text: string; authorName: string };
type ObservedInput = ObservedMessage & { scopeId: string; roomId: string };

export interface MemoryObserverOptions {
  supervisor?: {
    extractFacts(
      messages: ObservedMessage[],
      signal: AbortSignal,
    ): Promise<{ text: string; authorName: string }[]>;
  };
  memory: {
    addMemoryFact(scopeId: string, text: string, authorName: string): Promise<unknown>;
  };
  enqueue: (
    task: () => Promise<void>,
    onQueued?: undefined,
    options?: { priority?: number },
  ) => Promise<void>;
  logger: { info(...args: unknown[]): void };
  autoMemory: boolean;
  autoMemoryCooldownMs: number;
  autoMemoryCheckIntervalMs: number;
}

export interface MemoryObserver {
  /** Buffer one ordinary group statement; ignored when disabled, closed or rate limited. */
  observe(message: ObservedInput): void;
  /** Process one buffered room batch now. @returns Settles when the batch finished. */
  flush(): Promise<void>;
  /** Close the observer, drop buffered messages and abort in-flight extraction via `signal`. */
  stop(): void;
  /** Abort signal fired by stop(); shared with other background decisions for shutdown. */
  signal: AbortSignal;
  /** @returns Whether stop() was called. */
  closed(): boolean;
}

/**
 * Create the observer. Limits: 5 s debounce, 50 rooms, 8 messages of 900 characters per
 * batch, 1 saved fact per batch, 500 timing entries, queue priority -1.
 * @param options Injected extraction, storage, queue and rate-limit settings.
 * @returns Observer controls; no work happens until observe() is called.
 */
export function createMemoryObserver({
  supervisor,
  memory,
  enqueue,
  logger,
  autoMemory,
  autoMemoryCooldownMs,
  autoMemoryCheckIntervalMs,
}: MemoryObserverOptions): MemoryObserver {
  const observations = new Map<string, { scopeId: string; messages: ObservedMessage[] }>();
  const memoryTiming = new Map<string, { checked: number; saved: number }>();
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let job: Promise<void> | undefined;
  let isClosed = false;

  /** @param scopeId Group namespace. @returns Whether background memory is eligible now. */
  function canObserve(scopeId: string) {
    const state = memoryTiming.get(scopeId);
    return (
      !state ||
      (Date.now() - state.checked >= autoMemoryCheckIntervalMs &&
        Date.now() - state.saved >= autoMemoryCooldownMs)
    );
  }

  /** Schedule one bounded batch; background inference shares the generation queue. */
  function schedule() {
    if (!timer && !isClosed) {
      timer = setTimeout(() => {
        timer = undefined;
        void flush();
      }, 5000);
      timer.unref?.();
    }
  }

  /** @returns Process one room batch without overlapping user generation. */
  function flush(): Promise<void> {
    clearTimeout(timer);
    timer = undefined;
    if (job) return job;
    if (!observations.size || isClosed) return Promise.resolve();
    const [key, entry] = observations.entries().next().value;
    observations.delete(key);
    job = enqueue(
      async () => {
        if (isClosed || !canObserve(entry.scopeId)) return;
        const timing = memoryTiming.get(entry.scopeId) ?? { checked: -Infinity, saved: -Infinity };
        timing.checked = Date.now();
        memoryTiming.delete(entry.scopeId);
        memoryTiming.set(entry.scopeId, timing);
        if (memoryTiming.size > 500) memoryTiming.delete(memoryTiming.keys().next().value);
        try {
          const extracted = await supervisor.extractFacts(
            entry.messages.slice(-8),
            controller.signal,
          );
          for (const fact of extracted.slice(0, 1)) {
            if (isClosed) break;
            await memory.addMemoryFact(entry.scopeId, fact.text, fact.authorName);
            timing.saved = Date.now();
          }
          if (extracted.length)
            logger.info("[auto-memory]", { scopeId: entry.scopeId, count: extracted.length });
        } catch (error) {
          if (!isClosed) console.warn("Automatic memory extraction failed:", error.message);
        }
      },
      undefined,
      { priority: -1 },
    ).finally(() => {
      job = undefined;
      if (observations.size) schedule();
    });
    return job;
  }

  return {
    observe(message) {
      if (
        !supervisor ||
        !autoMemory ||
        isClosed ||
        !message.scopeId ||
        !message.text?.trim() ||
        !canObserve(message.scopeId)
      )
        return;
      const key = `${message.scopeId}:${message.roomId}`;
      if (!observations.has(key) && observations.size >= 50) return;
      const entry = observations.get(key) ?? { scopeId: message.scopeId, messages: [] };
      if (!entry.messages.some((item) => item.id === message.id))
        entry.messages.push({
          id: message.id,
          text: message.text.slice(0, 900),
          authorName: message.authorName,
        });
      entry.messages = entry.messages.slice(-8);
      observations.set(key, entry);
      schedule();
    },
    flush,
    stop() {
      isClosed = true;
      clearTimeout(timer);
      observations.clear();
      controller.abort();
    },
    signal: controller.signal,
    closed: () => isClosed,
  };
}
