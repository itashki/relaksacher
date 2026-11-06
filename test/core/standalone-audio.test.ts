/** @file Verify compiled DAVE/Opus playback without access to the build checkout. */
import { expect, test } from "bun:test";
import { standaloneAudioPlugin } from "../../scripts/audio-build.ts";
import { projectDirectory } from "../../src/core/project.ts";

/** Capture a local tool's output so failures include compiler or encoder diagnostics. */
async function run(cmd: string[]) {
  const child = Bun.spawn(cmd, { cwd: projectDirectory, stdout: "pipe", stderr: "pipe" });
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  expect(code, stderr).toBe(0);
  return stdout;
}

test.skipIf(!Bun.which("bwrap"))(
  "standalone audio encodes after DAVE loads with the source checkout hidden",
  async () => {
    const id = crypto.randomUUID();
    const bundled = `${projectDirectory}/dist/.audio-test-${id}.js`;
    const output = `/tmp/relaksacher-audio-test-${id}`;
    try {
      const result = await Bun.build({
        entrypoints: [`${projectDirectory}/test/support/compiled-audio.ts`],
        target: "bun",
        external: ["ffmpeg-static", "@snazzah/davey"],
        plugins: [standaloneAudioPlugin()],
      });
      expect(result.success, String(result.logs)).toBe(true);
      await Bun.write(bundled, result.outputs[0]);
      const assets: string[] = [];
      for await (const filename of new Bun.Glob("node_modules/@snazzah/davey-*/*.node").scan({
        cwd: projectDirectory,
      })) {
        assets.push("--asset", filename.slice(0, filename.lastIndexOf("/")));
      }
      await run([
        Bun.argv[0],
        "build",
        "--compile",
        bundled,
        "--external",
        "ffmpeg-static",
        ...assets,
        "--outfile",
        output,
      ]);
      expect(
        await run([
          "bwrap",
          "--ro-bind",
          "/",
          "/",
          "--tmpfs",
          projectDirectory,
          "--chdir",
          "/tmp",
          output,
        ]),
      ).toContain("Standalone DAVE and Opus encoding OK");
    } finally {
      await Promise.all(
        [bundled, output].map((path) =>
          Bun.file(path)
            .delete()
            .catch(() => {}),
        ),
      );
    }
  },
  30_000,
);
