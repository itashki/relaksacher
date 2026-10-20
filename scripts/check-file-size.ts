/** @file Enforce a physical 600-line limit for application, test and tooling TypeScript files. */
const limit = 600;
const root = Bun.fileURLToPath(new URL("../", import.meta.url));
const files = ["index.ts"];
for await (const file of new Bun.Glob("{src,test,scripts}/**/*.{ts,tsx}").scan(root))
  files.push(file);
const oversized = (
  await Promise.all(
    files.sort().map(async (file) => {
      const text = await Bun.file(`${root}/${file}`).text();
      const lines = text ? text.split("\n").length - Number(text.endsWith("\n")) : 0;
      return { file, lines };
    }),
  )
).filter(({ lines }) => lines > limit);
if (oversized.length) {
  for (const { file, lines } of oversized)
    console.error(`${file}: ${lines} lines (maximum ${limit})`);
  console.error(
    "Split oversized modules by responsibility; do not compress formatting to meet the limit.",
  );
  process.exitCode = 1;
} else console.log(`Checked ${files.length} TypeScript files: no file exceeds ${limit} lines.`);
