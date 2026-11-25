/** @file Verify the video-note crop builds the ffmpeg crop command and falls back to the original. */
import { expect, test } from "bun:test";
import { cropVideoNote } from "../../src/adapters/shared/video.ts";

test("crops to the central 60% and returns ffmpeg output", async () => {
  let args: string[] = [];
  const spawn = ((cmd: string[]) => (
    (args = cmd),
    { stdout: new Blob(["out"]).stream(), exited: Promise.resolve(0) }
  )) as unknown as typeof Bun.spawn;
  const result = await cropVideoNote(new Blob(["in"]), spawn);
  expect(args).toContain("crop=iw*0.6:ih*0.6");
  expect(await result.text()).toBe("out");
});

test("keeps the original bytes when ffmpeg fails", async () => {
  const original = new Blob(["in"]);
  const spawn = (() => ({
    stdout: new Blob([]).stream(),
    exited: Promise.resolve(1),
  })) as unknown as typeof Bun.spawn;
  expect(await cropVideoNote(original, spawn)).toBe(original);
});
