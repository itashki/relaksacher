/** @file Coalesce consecutive chat messages and retain bounded aliases for reply-based requests. */
type MessageInfo = {
  id: string;
  room: string;
  author: string;
  reply?: string;
  boundary?: boolean;
  immediate?: boolean;
};

/** Debounce one consecutive author per room, with a ten-second/20-message cap.
 * Every caller awaits the shared delivery. stop() discards pending work and resolves its callers.
 * Reply aliases retain at most 1000 message IDs; no platform history is fetched here. */
export function createMessageBatches<T>({
  windowMs,
  describe,
  merge,
  deliver,
}: {
  windowMs: number;
  describe: (message: T) => MessageInfo;
  merge: (messages: T[]) => T;
  deliver: (message: T) => Promise<void>;
}) {
  type Batch = {
    messages: T[];
    info: MessageInfo;
    started: number;
    timer?: ReturnType<typeof setTimeout>;
    waiters: { resolve: () => void; reject: (error: unknown) => void }[];
  };
  const pending = new Map<string, Batch>();
  const aliases = new Map<string, T>();
  let closed = false;
  const key = (room: string, id: string) => JSON.stringify([room, id]);
  /** Save a known group, including all chunks of one generated answer, for future explicit replies. */
  function remember(messages: T[]) {
    if (!messages.length) return;
    const combined = merge(messages);
    for (const message of messages) {
      const info = describe(message);
      const id = key(info.room, info.id);
      aliases.delete(id);
      aliases.set(id, combined);
    }
    while (aliases.size > 1000) aliases.delete(aliases.keys().next().value);
  }
  function flush(room: string) {
    const batch = pending.get(room);
    if (!batch) return;
    pending.delete(room);
    clearTimeout(batch.timer);
    const combined = merge(batch.messages);
    remember(batch.messages);
    void Promise.resolve()
      .then(() => {
        if (!closed) return deliver(combined);
      })
      .then(
        () => batch.waiters.forEach(({ resolve }) => resolve()),
        (error) => batch.waiters.forEach(({ reject }) => reject(error)),
      );
  }
  return {
    remember,
    /** Resolve only an observed message in the same room/topic; unknown IDs remain unchanged. */
    resolve(message: T, identity?: { room: string; id: string }): T {
      const info = identity ?? describe(message);
      return aliases.get(key(info.room, info.id)) ?? message;
    },
    /** End a run when another sender or a nontext/control event intervenes. */
    flush,
    /** Discard a pending run matching a control command, without starting delivery. */
    cancel(room: string, matches: (message: T) => boolean) {
      const batch = pending.get(room);
      if (!batch || !matches(batch.messages[0])) return;
      clearTimeout(batch.timer);
      pending.delete(room);
      for (const message of batch.messages) {
        const info = describe(message);
        aliases.delete(key(info.room, info.id));
      }
      batch.waiters.forEach(({ resolve }) => resolve());
    },
    push(message: T): Promise<void> {
      if (closed) return Promise.resolve();
      const info = describe(message);
      let batch = pending.get(info.room);
      if (
        batch &&
        (batch.info.author !== info.author ||
          info.boundary ||
          info.immediate ||
          (info.reply !== undefined && info.reply !== batch.info.reply) ||
          batch.messages.length >= 20)
      ) {
        flush(info.room);
        batch = undefined;
      }
      if (!windowMs || info.immediate) {
        remember([message]);
        return deliver(message);
      }
      if (!batch) {
        batch = { messages: [], info, started: Date.now(), waiters: [] };
        pending.set(info.room, batch);
      }
      batch.messages.push(message);
      remember(batch.messages);
      clearTimeout(batch.timer);
      const delay = Math.max(0, Math.min(windowMs, 10000 - (Date.now() - batch.started)));
      batch.timer = setTimeout(() => flush(info.room), delay);
      return new Promise<void>((resolve, reject) => batch.waiters.push({ resolve, reject }));
    },
    stop() {
      closed = true;
      for (const batch of pending.values()) {
        clearTimeout(batch.timer);
        batch.waiters.forEach(({ resolve }) => resolve());
      }
      pending.clear();
      aliases.clear();
    },
  };
}
