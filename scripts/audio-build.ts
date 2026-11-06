/** @file Make prism-media's dynamic Opus loader self-contained in standalone builds. */
import type { BunPlugin } from "bun";

/** Bundle the installed Opus encoder and its WASM bytes without runtime node_modules access. */
export function standaloneAudioPlugin(): BunPlugin {
  return {
    name: "standalone-audio",
    setup(build) {
      build.onLoad({ filter: /prism-media\/src\/util\/loader\.js$/ }, async ({ path }) => {
        const source = await Bun.file(path).text();
        // A literal require lets Bun include the encoder selected by prism-media at runtime.
        const contents = source.replace(
          "require(name)",
          '(name === "opusscript" ? require("opusscript") : require(name))',
        );
        if (contents === source)
          throw new Error("Unsupported prism-media loader; update audio build plugin");
        return { contents, loader: "js" };
      });
      build.onLoad({ filter: /opusscript\/index\.js$/ }, async ({ path }) => {
        const source = await Bun.file(path).text();
        const wasm = Buffer.from(
          await Bun.file(
            new URL("./build/opusscript_native_wasm.wasm", Bun.pathToFileURL(path)),
          ).arrayBuffer(),
        ).toString("base64");
        // Emscripten otherwise reads WASM relative to the original package directory.
        const contents = source.replace(
          'require("./build/opusscript_native_wasm.js")()',
          `require("./build/opusscript_native_wasm.js")({wasmBinary:Buffer.from("${wasm}","base64")})`,
        );
        if (contents === source)
          throw new Error("Unsupported opusscript loader; update audio build plugin");
        return { contents, loader: "js" };
      });
    },
  };
}
