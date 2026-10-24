/** @file Verify incremental frames avoid blanking, redundant writes and stale rows. */
import { expect, test } from "bun:test";
import { createFrameWriter } from "../../src/adapters/terminal/frame.ts";

test("frames skip identical screens and clear shortened or removed content", () => {
  const writes: string[] = [];
  const frame = createFrameWriter((data) => writes.push(data));
  frame("header\r\nlong answer\r\nfooter");
  frame("header\r\nlong answer\r\nfooter");
  expect(writes).toHaveLength(1);
  frame("header\r\nshort");
  expect(writes[1]).toBe("\x1b[?2026h\x1b[Hheader\x1b[K\r\nshort\x1b[K\x1b[J\x1b[?2026l");
  expect(writes.join("")).not.toContain("\x1b[2J");
});
