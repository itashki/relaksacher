/** @file Persistent operator/transport host with drainable, replaceable application code. */
import { createWhisperServer } from "./src/core/speech/whisper-server.ts";
import { createShutdown } from "./src/core/shutdown.ts";
import { createMusicMonitor } from "./src/core/music/status.ts";
import { createAssistantBridge } from "./src/core/assistant-bridge.ts";
import { createRestartController, createRestartRouter } from "./src/core/restart.ts";
import { createCliControls } from "./src/adapters/terminal/cli.ts";
import { loadApplication } from "./src/runtime/loader.ts";
import {
  createTransports,
  rejectRestartControl,
  validateRestartConfig,
} from "./src/runtime/transports.ts";
import type { RuntimeEvent } from "./src/runtime/contracts.ts";

const initial = await loadApplication();
const config = initial.config;
const music = createMusicMonitor();
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
let application = initial.module.createApplication(config, transports.connections, music.publish);
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
    const next = module.createApplication(nextConfig, transports.connections, music.publish);
    await application.dispose().catch((error) => console.error("Runtime cleanup failed:", error));
    if (shutdown.started) {
      await next.dispose();
      return;
    }
    application = next;
    bridge.replace(next.assistant);
    music.publish([]);
    console.info("Рестарт завершён: обновлённый код принимает сообщения из буфера.");
  },
});
const cli = process.stdin.isTTY
  ? createCliControls({
      assistant: bridge.assistant,
      music: config.adapters.includes("discord") ? music : undefined,
      onRestart: () => restart.restart(),
    })
  : null;
const whisper = createWhisperServer({
  url: config.whisperUrl,
  model: config.whisperModel,
  enabled: config.whisperAutoStart,
});
const shutdown = createShutdown({
  steps: [
    () => restart.close(),
    () => cli?.close(),
    () => bridge.close(),
    () => process.stdin.pause(),
    () => application.dispose(),
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
