/** @file Build a fresh module graph so restarts reload transitive local edits, not cached imports. */
import { mkdir } from "node:fs/promises";
import { projectDirectory } from "../core/project.ts";
import { resolvePath } from "../core/paths.ts";
import type { ApplicationModule } from "./contracts.ts";

declare const RELAKSACHER_COMPILED: boolean | undefined;

/**
 * Compile and validate the replacement before pausing delivery. Packages stay external
 * to preserve Discord class identity and native bindings across runtime generations.
 * Artifacts live under node_modules so normal package resolution keeps working.
 * Standalone/packaged runs reuse embedded modules and reload configuration only.
 */
export async function loadApplication(
  root = projectDirectory,
  env: Record<string, string | undefined> = Bun.env,
) {
  if (
    (typeof RELAKSACHER_COMPILED !== "undefined" && RELAKSACHER_COMPILED) ||
    Bun.env.RELAKSACHER_PACKAGED === "1"
  ) {
    const module = await import("./application.ts");
    return { module, config: await module.loadConfig(env) };
  }
  const result = await Bun.build({
    entrypoints: [resolvePath("src/runtime/application.ts", root)],
    target: "bun",
    packages: "external",
    define: { RELAKSACHER_PROJECT_DIRECTORY: JSON.stringify(root) },
  });
  if (!result.success) throw new AggregateError(result.logs, "Runtime build failed");
  const directory = resolvePath("node_modules/.cache/relaksacher", root);
  await mkdir(directory, { recursive: true });
  const filename = resolvePath(`runtime-${crypto.randomUUID()}.mjs`, directory);
  try {
    await Bun.write(filename, result.outputs[0]);
    const module: ApplicationModule = await import(Bun.pathToFileURL(filename).href);
    const config = await module.loadConfig(env);
    return { module, config };
  } finally {
    await Bun.file(filename)
      .delete()
      .catch(() => {});
  }
}
