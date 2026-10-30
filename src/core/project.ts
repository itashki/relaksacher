/** @file Resolve project assets consistently in source and freshly bundled runtimes. */
declare const RELAKSACHER_COMPILED: boolean | undefined;
declare const RELAKSACHER_PROJECT_DIRECTORY: string | undefined;

/** Data root: repository for source runs, working directory for standalone executables. */
export const projectDirectory =
  typeof RELAKSACHER_PROJECT_DIRECTORY === "string"
    ? RELAKSACHER_PROJECT_DIRECTORY
    : typeof RELAKSACHER_COMPILED !== "undefined" && RELAKSACHER_COMPILED
      ? process.cwd()
      : Bun.fileURLToPath(new URL("../../", import.meta.url));
