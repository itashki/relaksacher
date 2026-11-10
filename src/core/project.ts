/** @file Resolve project assets consistently in source runs and standalone executables. */
declare const RELAKSACHER_COMPILED: boolean | undefined;

/** Data root: repository for source runs, working directory for standalone executables. */
export const projectDirectory =
  typeof RELAKSACHER_COMPILED !== "undefined" && RELAKSACHER_COMPILED
    ? process.cwd()
    : Bun.fileURLToPath(new URL("../../", import.meta.url));
