/** @file Verify the one-resident-model manager and the llama-server command. */
import { expect, test } from "bun:test";
import { createLlamaServer, createModelServers, gigaamKey } from "../../src/core/llama/servers.ts";

/** Fake servers that log events; `gate` delays the first stop until released. */
function harness({ failStart = false, gate }: { failStart?: boolean; gate?: Promise<void> } = {}) {
  const log: string[] = [];
  let first = true;
  const servers = createModelServers({
    create: (key) => ({
      async start() {
        log.push(`start ${key}`);
        if (failStart && first) {
          first = false;
          throw new Error("boom");
        }
      },
      async stop() {
        log.push(`stop ${key}`);
        if (gate) await gate;
        log.push(`stopped ${key}`);
      },
    }),
  });
  const job = (name: string) => async () => {
    log.push(`job ${name}`);
    await Bun.sleep(1);
    return name;
  };
  return { log, servers, job };
}

test("queued same-key jobs share one load, and an empty queue unloads", async () => {
  const { log, servers, job } = harness();
  await Promise.all([servers.use("A", job("1")), servers.use("A", job("2"))]);
  expect(log).toEqual(["start A", "job 1", "job 2", "stop A", "stopped A"]);
  log.length = 0;
  await servers.use("A", job("3"));
  expect(log).toEqual(["start A", "job 3", "stop A", "stopped A"]);
});

test("queued A, B, A reload each time and starts wait for the previous stop", async () => {
  let release!: () => void;
  const { log, servers, job } = harness({ gate: new Promise((r) => (release = r)) });
  const done = Promise.all([
    servers.use("A", job("1")),
    servers.use("B", job("2")),
    servers.use(gigaamKey, job("3")),
  ]);
  await Bun.sleep(20);
  expect(log).toEqual(["start A", "job 1", "stop A"]);
  release();
  expect(await done).toEqual(["1", "2", "3"]);
  expect(log.filter((l) => l.startsWith("start") || l.startsWith("stopped"))).toEqual([
    "start A",
    "stopped A",
    "start B",
    "stopped B",
    "start gigaam",
    "stopped gigaam",
  ]);
});

test("a throwing job still unloads and the next job runs; a failed start retries", async () => {
  const { log, servers, job } = harness({ failStart: true });
  await expect(servers.use("A", job("1"))).rejects.toThrow("boom");
  expect(log).toEqual(["start A", "stop A", "stopped A"]);
  await expect(servers.use("A", async () => Promise.reject(new Error("bad")))).rejects.toThrow(
    "bad",
  );
  expect(await servers.use("A", job("2"))).toBe("2");
  expect(log.filter((l) => l === "start A")).toHaveLength(3);
});

test("a promise settles only after the due stop", async () => {
  let release!: () => void;
  const { servers, job } = harness({ gate: new Promise((r) => (release = r)) });
  let settled = false;
  const result = servers.use("A", job("1")).then(() => (settled = true));
  await Bun.sleep(20);
  expect(settled).toBe(false);
  release();
  await result;
});

test("dispose stops the server, rejects queued jobs and later use", async () => {
  const { log, servers } = harness();
  const running = servers.use("A", () => new Promise<never>(() => undefined));
  const queued = servers.use("B", async () => "b");
  await Bun.sleep(5);
  await servers.dispose();
  await expect(queued).rejects.toThrow("disposed");
  await expect(servers.use("A", async () => "a")).rejects.toThrow("disposed");
  expect(log).toEqual(["start A", "stop A", "stopped A"]);
  void running;
});

test("llama server command uses absolute paths, -np 1 and port 8084", async () => {
  let command: string[] = [];
  let spawned = false;
  let exit!: (code: number) => void;
  const exited = new Promise<number>((r) => (exit = r));
  const server = createLlamaServer({
    model: "/m/model.gguf",
    mmproj: "/m/proj.gguf",
    numCtx: 8192,
    fetchImpl: async () => Response.json({ status: spawned ? "ok" : "loading" }),
    spawn: (args) => {
      spawned = true;
      command = args;
      return { exitCode: null, exited, kill: () => exit(0) };
    },
  });
  await server.start();
  expect(command.slice(0, 5)).toEqual([
    "llama-server",
    "-m",
    "/m/model.gguf",
    "--mmproj",
    "/m/proj.gguf",
  ]);
  expect(command.join(" ")).toContain("-np 1 -c 8192 --host 127.0.0.1 --port 8084");
  await server.stop();
});
