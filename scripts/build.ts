/** @file Build a standalone host with embedded audio dependencies and optional experimental AOT. */
import { rename } from "node:fs/promises";
import { projectDirectory } from "../src/core/project.ts";

process.chdir(projectDirectory);
const options = Bun.argv.slice(2);
if (options.some((option) => option !== "--aot")) {
  throw new Error("Usage: ./build.sh [--aot]");
}
const aot = options.includes("--aot");
if (aot) {
  const help = Bun.spawnSync([process.execPath, "build", "--help"]);
  if (!help.stdout.toString().includes("--aot")) {
    throw new Error("AOT requires the pinned compiler; run ./build.sh --aot");
  }
}

// NAPI loaders need the original package paths, including package.json, at runtime.
const assets: string[] = [];
for await (const filename of new Bun.Glob("node_modules/@snazzah/davey-*/*.node").scan()) {
  assets.push("--asset", filename.slice(0, filename.lastIndexOf("/")));
}
if (!assets.length) throw new Error("Missing DAVE native bindings; run bun install first");

// Compile beside the final binary, then atomically replace it even while the service is running.
const output = `dist/.relaksacher-${crypto.randomUUID()}`;
const child = Bun.spawn(
  [
    process.execPath,
    "build",
    "--compile",
    // The default JIT handles dependency runtime regexes and optional module loaders.
    // AOT remains opt-in: its diagnostics describe real compatibility/performance limits.
    ...(aot ? ["--aot"] : []),
    "--define",
    "RELAKSACHER_COMPILED=true",
    // prism-media selects the Opus implementation with a dynamic require().
    "./index.ts",
    "./node_modules/opusscript/index.js",
    "--asset",
    "./node_modules/opusscript/build/opusscript_native_wasm.wasm",
    ...assets,
    // prism-media falls back to the system ffmpeg when this optional package is absent.
    "--external",
    "ffmpeg-static",
    "--outfile",
    output,
  ],
  { stdin: "inherit", stdout: "inherit", stderr: "inherit" },
);
const status = await child.exited;
if (status === 0) {
  await rename(output, "dist/relaksacher");
} else {
  await Bun.file(output)
    .delete()
    .catch(() => {});
}
process.exitCode = status;
