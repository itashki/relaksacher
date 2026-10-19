/** @file Bounded opt-in policy for occasional unsolicited group replies. */

/**
 * Create a sampled, cooldown-limited decision gate; it never sends messages itself.
 * @returns Scoped message consideration function.
 */
export function createSpontaneousPolicy({
  decide,
  enqueue,
  enabled = true,
  chance = 0.05,
  cooldownMs = 300000,
  random = Math.random,
  now = Date.now,
}: {
  decide?: (message: import("../types.ts").ObservedMessage) => Promise<{ angle: string } | null>;
  enqueue: ReturnType<typeof import("./queue.ts").createRequestQueue>;
  enabled?: boolean;
  chance?: number;
  cooldownMs?: number;
  random?: () => number;
  now?: () => number;
}) {
  const rooms = new Map<string, { checked: number; replied: number }>();
  let busy = false;
  return async (message: import("../types.ts").ObservedMessage) => {
    if (
      !enabled ||
      !decide ||
      !message.scopeId ||
      !message.text?.trim() ||
      message.text.trim().startsWith("/")
    )
      return null;
    const key = `${message.scopeId}:${message.roomId}`;
    const state = rooms.get(key) ?? { checked: -Infinity, replied: -Infinity };
    const started = now();
    if (busy || started - state.checked < 30000 || started - state.replied < cooldownMs)
      return null;
    state.checked = started;
    rooms.delete(key);
    rooms.set(key, state);
    if (rooms.size > 200) rooms.delete(rooms.keys().next().value);
    if (random() >= chance) return null;
    busy = true;
    try {
      return await enqueue(
        async () => {
          if (now() - started > 60000) return null;
          const decision = await decide(message);
          if (!decision || now() - started > 60000) return null;
          state.replied = now();
          return decision;
        },
        undefined,
        { priority: -1 },
      );
    } catch (error) {
      console.warn("Spontaneous reply decision failed:", error.message);
      return null;
    } finally {
      busy = false;
    }
  };
}
