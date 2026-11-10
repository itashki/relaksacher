/** @file Application startup, operator commands and messenger/speech lifecycle. */
import { createWhisperServer } from "./src/core/speech/whisper-server.ts";
import { createGigaamServer } from "./src/core/speech/gigaam-server.ts";
import { createShutdown } from "./src/core/shutdown.ts";
import { createRequestLog } from "./src/core/request-log.ts";
import { resolvePath } from "./src/core/paths.ts";
import { projectDirectory } from "./src/core/project.ts";
import { createStatistics } from "./src/core/statistics.ts";
import { createMusicMonitor } from "./src/core/music/status.ts";
import { createRequestLifecycle, createServiceRestart } from "./src/core/service-restart.ts";
import type { RuntimeEvent } from "./src/runtime/contracts.ts";
import { createApplication } from "./src/runtime/application.ts";
import { loadConfig } from "./src/config.ts";
import { createCliControls } from "./src/adapters/terminal/cli.ts";
import { createTransports } from "./src/runtime/transports.ts";
import { controlSocket, controlRequest, createControlServer } from "./src/runtime/control.ts";

const mode = Bun.argv[2];
if (mode === "check-audio") {
  const { checkDiscordAudio } = await import("./src/adapters/discord/audio-check.ts");
  await checkDiscordAudio();
  console.log("DAVE and Opus encoding OK");
  process.exit(0);
}
if (mode === "restart") {
  try {
    await controlRequest(controlSocket(), "/restart", "POST");
    console.log("Перезапуск сервиса запрошен. Бот завершит принятые запросы перед выходом.");
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
  process.exit(0);
}
if (mode === "tui") {
  const { attachTerminal } = await import("./src/adapters/terminal/attach.ts");
  try {
    await attachTerminal(controlSocket());
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
  process.exit(0);
}
if (mode && mode !== "service")
  throw new Error("Usage: relaksacher [service|tui|restart|check-audio]");
const config = await loadConfig();
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
const requests = createRequestLifecycle<RuntimeEvent>((event) => application.handle(event));
const transports = createTransports(config, requests.dispatch);
const application = createApplication(config, transports.connections, music.publish, recordRequest);
const cli =
  mode !== "service" && process.stdin.isTTY
    ? createCliControls({
        assistant: application.assistant,
        statistics,
        music: config.adapters.includes("discord") ? music : undefined,
      })
    : null;
const restart = createServiceRestart({
  stopReceiving: () => transports.stopReceiving(),
  drain: async () => {
    await requests.drain();
    await application.assistant.flushObservations();
  },
  // systemd Restart=on-failure launches a fresh process after this intentional exit.
  shutdown: () => shutdown.run(75),
});
const control =
  mode === "service"
    ? await createControlServer({
        socket: controlSocket(),
        assistant: application.assistant,
        music,
        statistics,
        activeRequests: requests.activeRequests,
        restart,
      })
    : null;
const speech =
  config.transcriptionBackend === "gigaam"
    ? createGigaamServer(config.gigaam)
    : createWhisperServer({
        url: config.whisperUrl,
        model: config.whisperModel,
        enabled: config.whisperAutoStart,
      });
const shutdown = createShutdown({
  steps: [
    () => control?.close(),
    () => cli?.close(),
    () => process.stdin.pause(),
    async () => {
      await application.dispose();
      await requestLog.close();
    },
    () => transports.stop(),
    () => speech.stop(),
  ],
});
for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => void shutdown.run());
speech
  .start()
  .then(() => {
    if (!shutdown.started) return transports.start();
  })
  .catch((error) => {
    if (shutdown.started) return;
    console.error("Failed to start application:", error);
    void shutdown.run(1);
  });
