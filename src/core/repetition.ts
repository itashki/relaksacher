/** @file Detect consecutive repeated phrases independently of stream chunk boundaries. */

/**
 * Create a bounded detector for five consecutive copies of a phrase (up to 256 words).
 * Whitespace is ignored; short punctuation and one-letter runs do not count as phrases.
 * @returns A per-stream-channel detector; push returns true once repetition is found.
 */
export function createRepetitionDetector() {
  let tail = "";
  return {
    push(delta: string): boolean {
      if (!delta) return false;
      const previousWords = tail.trim().split(/\s+/).length;
      tail += delta;
      const words = tail.trim().split(/\s+/);
      for (let end = Math.max(5, previousWords); end <= words.length; end++) {
        for (let size = 1; size <= Math.min(256, Math.floor(end / 5)); size++) {
          const phrase = words.slice(end - size, end).join(" ");
          if (phrase.length < 3 || !/[\p{L}\p{N}]/u.test(phrase)) continue;
          let repeated = true;
          for (let copy = 2; copy <= 5; copy++) {
            if (words.slice(end - size * copy, end - size * (copy - 1)).join(" ") !== phrase) {
              repeated = false;
              break;
            }
          }
          if (repeated) return true;
        }
      }
      tail = words.slice(-1280).join(" ") + (/\s$/.test(tail) ? " " : "");
      return false;
    },
  };
}
