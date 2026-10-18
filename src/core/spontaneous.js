/** @file Bounded opt-in policy for occasional unsolicited group replies. */

/**
 * Create a sampled, cooldown-limited decision gate; it never sends messages itself.
 * @param {object} options Policy dependencies.
 * @param {Function} options.decide Small-model classifier.
 * @param {Function} options.enqueue Shared inference queue.
 * @param {boolean} [options.enabled=true] Enable unsolicited replies.
 * @param {number} [options.chance=0.05] Fraction of eligible messages evaluated.
 * @param {number} [options.cooldownMs=300000] Minimum interval between replies per room.
 * @param {function(): number} [options.random=Math.random] Sampling source.
 * @param {function(): number} [options.now=Date.now] Clock for deadlines.
 * @returns {Function} Scoped message consideration function.
 */
export function createSpontaneousPolicy({ decide, enqueue, enabled = true, chance = 0.05, cooldownMs = 300000, random = Math.random, now = Date.now }) {
  const rooms = new Map();
  let busy = false;
  return async (message) => {
    if (!enabled || !decide || !message.scopeId || !message.text?.trim() || message.text.trim().startsWith("/")) return null;
    const key = `${message.scopeId}:${message.roomId}`;
    const state = rooms.get(key) ?? { checked: -Infinity, replied: -Infinity };
    const started = now();
    if (busy || started - state.checked < 30000 || started - state.replied < cooldownMs) return null;
    state.checked = started;
    rooms.delete(key);
    rooms.set(key, state);
    if (rooms.size > 200) rooms.delete(rooms.keys().next().value);
    if (random() >= chance) return null;
    busy = true;
    try {
      return await enqueue(async () => {
        if (now() - started > 60000) return null;
        const decision = await decide(message);
        if (!decision || now() - started > 60000) return null;
        state.replied = now();
        return decision;
      }, undefined, { priority: -1 });
    } catch (error) {
      console.warn("Spontaneous reply decision failed:", error.message);
      return null;
    } finally { busy = false; }
  };
}
