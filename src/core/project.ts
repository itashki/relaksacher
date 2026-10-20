/** @file Resolve project assets consistently in source and freshly bundled runtimes. */
declare const RELAKSACHER_PROJECT_DIRECTORY: string | undefined;

/** Absolute repository root, embedded by the restart loader when bundling local modules. */
export const projectDirectory =
  typeof RELAKSACHER_PROJECT_DIRECTORY === "string"
    ? RELAKSACHER_PROJECT_DIRECTORY
    : Bun.fileURLToPath(new URL("../../", import.meta.url));
