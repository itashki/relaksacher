/** @file Persistent operator/transport host with drainable, replaceable application code. */
import { createWhisperServer } from "./src/core/speech/whisper-server.ts";
import { createShutdown } from "./src/core/shutdown.ts";
import { createRequestLog } from "./src/core/request-log.ts";
import { resolvePath } from "./src/core/paths.ts";
import { projectDirectory } from "./src/core/project.ts";
import { createStatistics } from "./src/core/statistics.ts";
import { createMusicMonitor } from "./src/core/music/status.ts";
import { createAssistantBridge } from "./src/core/assistant-bridge.ts";
import { createRestartController, createRestartRouter } from "./src/core/restart.ts";
import { loadApplication } from "./src/runtime/loader.ts";
import {
  createTransports,
  rejectRestartControl,
  validateRestartConfig,
} from "./src/runtime/transports.ts";
import type { RuntimeEvent } from "./src/runtime/contracts.ts";

import { controlSocket, createControlServer } from "./src/runtime/control.ts";

const mode = Bun.argv[2];
if (mode === "tui") {
  const { attachTerminal } = await import("./src/adapters/terminal/attach.ts");
  await attachTerminal(controlSocket());
  process.exit(0);
}
if (mode && mode !== "service") throw new Error("Usage: relaksacher [service|tui]");
const initial = await loadApplication();
const config = initial.config;
const terminalSession = initial.module.createTerminalSession();
const music = createMusicMonitor();
const statistics = createStatistics();
const requestLog = createRequestLog(
  resolvePath(Bun.env.REQUEST_LOG_FILE || "logs/requests.jsonl", projectDirectory),
);
const recordRequest: import("./src/core/statistics.ts").RecordRequest = (
  feature,
  context,
  details,
) => {
  if (details?.kind !== "tool") statistics.record(feature);
  requestLog.record(feature, context, details);
};
let draining = false;
let replacing = false;
const transports = createTransports(config, (event, cancellation) => {
  const control =
    event.kind === "discord-interaction" ||
    (event.kind === "telegram-update" && Boolean(event.update.callback_query));
  if (draining && control) {
    if (cancellation && !replacing) return router.control(event);
    return rejectRestartControl(event, transports.connections);
  }
  return router.dispatch(event);
});
let application = initial.module.createApplication(
  config,
  transports.connections,
  music.publish,
  recordRequest,
);
const bridge = createAssistantBridge(application.assistant);
const router = createRestartRouter<RuntimeEvent>((event) => application.handle(event));
const restart = createRestartController({
  prepare: async () => {
    const prepared = await loadApplication();
    validateRestartConfig(config, prepared.config);
    return prepared;
  },
  router: {
    pause() {
      draining = true;
      router.pause();
      console.info("Рестарт: ожидаю завершения принятых запросов; новые сообщения буферизуются.");
    },
    async drain() {
      await router.drain();
      replacing = true;
      await application.assistant.flushObservations();
    },
    resume() {
      draining = false;
      replacing = false;
      router.resume();
    },
  },
  replace: async ({ module, config: nextConfig }) => {
    const next = module.createApplication(
      nextConfig,
      transports.connections,
      music.publish,
      recordRequest,
    );
    await application.dispose().catch((error) => console.error("Runtime cleanup failed:", error));
    if (shutdown.started) {
      await next.dispose();
      return;
    }
    application = next;
    bridge.replace(next.assistant);
    music.publish([]);
    if (cli) {
      const previous = cliModule;
      await cli.close();
      if (shutdown.started) return;
      try {
        cli = openTerminal(module);
        cliModule = module;
      } catch (error) {
        cli = openTerminal(previous);
        console.error("Не удалось обновить TUI, восстановлен предыдущий интерфейс:", error);
      }
    }
    console.info("Рестарт завершён: обновлённый код принимает сообщения из буфера.");
  },
});
/** Recreate only terminal handlers, retaining process telemetry, logs and live connections. */
function openTerminal(module: typeof initial.module) {
  return module.createCliControls({
    assistant: bridge.assistant,
    statistics,
    session: terminalSession,
    music: config.adapters.includes("discord") ? music : undefined,
    onRestart: () => restart.restart(),
  });
}
let cliModule = initial.module;
let cli = mode !== "service" && process.stdin.isTTY ? openTerminal(cliModule) : null;
const control =
  mode === "service"
    ? await createControlServer({
        socket: controlSocket(),
        assistant: bridge.assistant,
        music,
        statistics,
        restart: () => restart.restart(),
      })
    : null;
const whisper = createWhisperServer({
  url: config.whisperUrl,
  model: config.whisperModel,
  enabled: config.whisperAutoStart,
});
const shutdown = createShutdown({
  steps: [
    () => control?.close(),
    () => restart.close(),
    () => cli?.close(),
    () => bridge.close(),
    () => process.stdin.pause(),
    async () => {
      await application.dispose();
      await requestLog.close();
    },
    () => transports.stop(),
    () => whisper.stop(),
  ],
});
for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => void shutdown.run());
whisper
  .start()
  .then(() => {
    if (!shutdown.started) return transports.start();
  })
  .catch((error) => {
    if (shutdown.started) return;
    console.error("Failed to start application:", error);
    void shutdown.run(1);
  });
