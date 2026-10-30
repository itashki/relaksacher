/** @file Build the host and its dynamically selected audio dependencies into an AOT executable. */
import { projectDirectory } from "../src/core/project.ts";

process.chdir(projectDirectory);
const help = Bun.spawnSync([process.execPath, "build", "--help"]);
if (!help.stdout.toString().includes("--aot")) {
  throw new Error("AOT requires Bun canary: nix shell path:.#bun-canary --command bun run build");
}

// NAPI loaders need the original package paths, including package.json, at runtime.
const assets: string[] = [];
for await (const filename of new Bun.Glob("node_modules/@snazzah/davey-*/*.node").scan()) {
  assets.push("--asset", filename.slice(0, filename.lastIndexOf("/")));
}
if (!assets.length) throw new Error("Missing DAVE native bindings; run bun install first");

const child = Bun.spawn(
  [
    process.execPath,
    "build",
    "--compile",
    "--aot",
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
    "dist/relaksacher",
  ],
  { stdin: "inherit", stdout: "inherit", stderr: "inherit" },
);
process.exitCode = await child.exited;
