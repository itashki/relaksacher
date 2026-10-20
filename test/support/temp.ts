/** @file Bun-backed temporary directories with per-test cleanup. */
import { onTestFinished } from "bun:test";
import { resolvePath } from "../../src/core/paths.ts";

/** Create an isolated directory and remove it after the current test. */
export async function temporaryDirectory(prefix: string) {
  const directory = resolvePath(
    `${prefix}${crypto.randomUUID()}`,
    Bun.env.TMPDIR || Bun.env.TEMP || "/tmp",
  );
  await Bun.$`mkdir ${directory}`.quiet();
  onTestFinished(async () => {
    await Bun.$`rm -rf ${directory}`.quiet();
  });
  return directory;
}
