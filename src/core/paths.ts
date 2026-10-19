/** @file Resolve filesystem destinations without requiring them to exist or interpreting URL punctuation. */
/** Resolve a filesystem path, including destinations that do not exist yet. */
export function resolvePath(filename: string, directory: string): string {
  if (filename.startsWith("/")) return Bun.fileURLToPath(Bun.pathToFileURL(filename));
  const base = Bun.pathToFileURL(`${directory.replace(/\/+$/, "")}/`);
  // Encode URL punctuation so names containing #, ? or % remain literal paths.
  const path = filename.split("/").map(encodeURIComponent).join("/");
  return Bun.fileURLToPath(new URL(path, base));
}
