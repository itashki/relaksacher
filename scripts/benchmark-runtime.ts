/** @file Compare compiled JIT/AOT on real bot CPU paths, without network or chat side effects. */
import { formatTelegramChunks } from "../src/adapters/telegram/format.ts";
import { searchLines } from "../src/adapters/terminal/search.ts";
import { buildMessages } from "../src/core/assistant/prompt.ts";
import { guardContext } from "../src/core/assistant/context.ts";
import { load } from "cheerio";

const paragraph =
  "**Привет!** Here is a [source](https://example.com) with `code`, *emphasis* and Unicode 🦊.\n\n";
const markdown = paragraph.repeat(20) + "```ts\nconst answer = 42;\n```";
const html = `<html><body><nav>Navigation</nav><main>${Array.from(
  { length: 80 },
  (_, i) => `<p>${i}: ${paragraph}<a href="https://example.com/${i}">Source</a></p>`,
).join("")}</main><script>ignored()</script></body></html>`;
const rows = Array.from({ length: 200 }, (_, i) => `${i}: ${paragraph}`);
const conversation = Array.from({ length: 20 }, (_, i) => ({
  role: i % 2 ? "assistant" : "user",
  content: paragraph.repeat(2),
}));
let checksum = 0;
const workloads = {
  telegram_format() {
    return formatTelegramChunks(markdown, "model").join("").length;
  },
  model_context() {
    const messages = buildMessages({ conversation });
    guardContext(messages, [], 16384);
    return messages.length + messages[0].content.length;
  },
  tui_search() {
    return searchLines(rows, "source", (line) => [line.slice(0, 60), line.slice(60)]).matches
      .length;
  },
  web_extract() {
    const $ = load(html);
    $("script,style,noscript,nav,footer,header,form,svg").remove();
    return $("main,article").first().text().length;
  },
};
type Trial = {
  mode: string;
  results: Record<string, number>;
  outputs: Record<string, number>;
  peakRssKiB: number;
  checksum: number;
};

/** Run bounded batches; a visible checksum keeps all workload results observable. */
function sample(work: () => number, durationMs: number) {
  const start = performance.now();
  let iterations = 0;
  do {
    for (let i = 0; i < 10; i++) checksum += work();
    iterations += 10;
  } while (performance.now() - start < durationMs);
  return iterations / ((performance.now() - start) / 1000);
}

/** Warm each real CPU path, then report throughput and process peak RSS in KiB. */
function worker() {
  const results: Record<string, number> = {};
  const outputs = Object.fromEntries(
    Object.entries(workloads).map(([name, work]) => [name, work()]),
  );
  for (const [name, work] of Object.entries(workloads)) {
    sample(work, 500);
    const samples = Array.from({ length: 3 }, () => sample(work, 750));
    results[name] = samples.sort((a, b) => a - b)[1];
  }
  console.log(
    JSON.stringify({ results, outputs, peakRssKiB: process.resourceUsage().maxRSS, checksum }),
  );
}

/** Build both modes with the same compiler and alternate trial order to reduce timing bias. */
async function benchmark() {
  const directory = "/tmp/relaksacher-runtime-benchmark";
  const entry = Bun.fileURLToPath(import.meta.url);
  for (const mode of ["jit", "aot"]) {
    const child = Bun.spawn(
      [
        process.execPath,
        "build",
        "--compile",
        ...(mode === "aot" ? ["--aot"] : []),
        entry,
        "--outfile",
        `${directory}/${mode}`,
      ],
      { stdout: "inherit", stderr: "inherit" },
    );
    if ((await child.exited) !== 0) throw new Error(`${mode} build failed`);
  }
  const trials: Trial[] = [];
  const affinity = Bun.env.BENCH_CPU;
  for (const mode of ["jit", "aot", "aot", "jit", "jit", "aot"]) {
    const child = Bun.spawn(
      [...(affinity ? ["taskset", "-c", affinity] : []), `${directory}/${mode}`, "--worker"],
      {
        stdout: "pipe",
        stderr: "inherit",
      },
    );
    const output = await new Response(child.stdout).text();
    if ((await child.exited) !== 0) throw new Error(`${mode} worker failed`);
    const result: Trial = { mode, ...JSON.parse(output) };
    trials.push(result);
    console.info(JSON.stringify(result));
  }
  if (trials.some((trial) => JSON.stringify(trial.outputs) !== JSON.stringify(trials[0].outputs))) {
    throw new Error("JIT/AOT produced different workload outputs");
  }
  await Bun.write(
    `${directory}/results.json`,
    JSON.stringify({ compiler: Bun.version, affinity, trials }, null, 2),
  );
}

if (Bun.argv.includes("--worker")) worker();
else await benchmark();
