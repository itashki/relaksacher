/** @file Local terminal controls for a running bot. */
import { createTui } from "./tui.ts";

/** Listen for operator commands without stopping the messenger adapters. */
export function createCliControls({ assistant, input, output }: {
  assistant: import("../types.ts").Assistant;
  input?: ReadableStream<Uint8Array>;
  output?: Pick<Bun.FileSink, "write">;
}) {
  if (!input && !output && process.stdin.isTTY && process.stdout.isTTY) return createTui({ assistant });
  const reader = (input ?? Bun.stdin.stream()).getReader();
  const sink = output ? null : Bun.stdout.writer();
  const writer = output ?? sink;
  const help = "CLI: stop — остановить текущую генерацию; help — показать команды.\n";
  let closed = false;
  const write = (text: string) => { writer.write(text); sink?.flush(); };
  const command = (line: string) => {
    const value = line.trim().toLowerCase();
    if (value === "stop") {
      write(assistant.stopCurrentGeneration()
        ? "Остановка генерации запрошена. Бот продолжает работать.\n"
        : "Нет активной генерации для остановки.\n");
    } else if (value === "help") {
      write(help);
    } else if (value) {
      write("Неизвестная команда. Введите help.\n");
    }
  };
  write(help);
  const done = (async () => {
    const decoder = new TextDecoder();
    let pending = "";
    try {
      while (!closed) {
        const { value, done } = await reader.read();
        if (closed) break;
        pending += decoder.decode(value, { stream: !done });
        const lines = pending.split(/\r\n|[\r\n]/);
        pending = lines.pop() ?? "";
        for (const line of lines) {
          if (closed) break;
          command(line);
        }
        if (done) { if (pending) command(pending); break; }
      }
    } catch (error) {
      if (!closed) console.error("CLI input failed:", error);
    } finally {
      closed = true;
      reader.releaseLock();
      sink?.end();
    }
  })();
  return {
    done,
    close() {
      if (closed) return;
      closed = true;
      void reader.cancel().catch(() => {});
    },
  };
}
