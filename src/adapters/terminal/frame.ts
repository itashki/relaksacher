/** @file Paint dashboard frames without clearing the screen before drawing. */

/** Skip identical frames and group row replacement into one synchronized terminal update. */
export function createFrameWriter(write: (data: string) => unknown) {
  let previous: string | undefined;
  return (screen: string) => {
    if (screen === previous) return;
    const rows = screen.split("\r\n").map((row) => `${row}\x1b[K`);
    write(`\x1b[?2026h\x1b[H${rows.join("\r\n")}\x1b[J\x1b[?2026l`);
    previous = screen;
  };
}
