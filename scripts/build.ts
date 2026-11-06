/** @file Build a standalone host with embedded audio dependencies and optional experimental AOT. */
import { rename } from "node:fs/promises";
import { projectDirectory } from "../src/core/project.ts";
import { standaloneAudioPlugin } from "./audio-build.ts";

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
const bundled = `${output}.js`;
const bundle = await Bun.build({
  entrypoints: ["./index.ts"],
  target: "bun",
  define: { RELAKSACHER_COMPILED: "true" },
  // Native modules must be bundled by the final compiler so their embedded paths remain valid.
  external: ["ffmpeg-static", "@snazzah/davey"],
  plugins: [standaloneAudioPlugin()],
});
if (!bundle.success) throw new AggregateError(bundle.logs, "Failed to bundle application");
await Bun.write(bundled, bundle.outputs[0]);
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
    bundled,
    ...assets,
    // prism-media falls back to the system ffmpeg when this optional package is absent.
    "--external",
    "ffmpeg-static",
    "--outfile",
    output,
  ],
  { stdin: "inherit", stdout: "inherit", stderr: "inherit" },
);
let status = await child.exited;
await Bun.file(bundled).delete();
if (status === 0) {
  // Exercise the actual binary before replacing a working installation.
  const audioCheck = Bun.spawn([`./${output}`, "check-audio"], {
    stdin: "ignore",
    stdout: "inherit",
    stderr: "inherit",
  });
  status = await audioCheck.exited;
}
if (status === 0) {
  await rename(output, "dist/relaksacher");
} else {
  await Bun.file(output)
    .delete()
    .catch(() => {});
}
process.exitCode = status;
