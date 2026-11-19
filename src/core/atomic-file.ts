/** @file Replace a file's contents atomically through a sibling temporary file. */
import { rename } from "node:fs/promises";

/**
 * Write `contents` to `${file}.tmp`, then rename it over `file` so readers never see a partial file.
 * Callers serialize concurrent writes to the same file themselves.
 * @param file Target path.
 * @param contents Complete new file contents.
 * @param options `createPath` creates missing parent directories for the temporary file.
 * @returns Resolves after the rename.
 */
export async function replaceFileAtomically(
  file: string,
  contents: string,
  options: { createPath?: boolean } = {},
): Promise<void> {
  const temporary = `${file}.tmp`;
  if (options.createPath === undefined) await Bun.write(temporary, contents);
  else await Bun.write(temporary, contents, { createPath: options.createPath });
  // rename is kept on purpose: it is the atomic replacement primitive (see CLAUDE.md).
  await rename(temporary, file);
}
