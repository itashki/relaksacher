/** @file Local terminal controls for a running bot. */
import { createInterface } from "node:readline";
import { createTui } from "./tui.ts";

/**
 * Listen for operator commands without stopping the messenger adapters.
 * @returns Terminal lifecycle.
 */
export function createCliControls({ assistant, input = process.stdin, output = process.stdout }: { assistant: import("../types.ts").Assistant; input?: NodeJS.ReadableStream & { isTTY?: boolean; setRawMode?: (mode: boolean) => void }; output?: NodeJS.WritableStream & { isTTY?: boolean; columns?: number; rows?: number }; }) {
  if (input.isTTY && output.isTTY) return createTui({ assistant, input, output });
  const help = "CLI: stop — остановить текущую генерацию; help — показать команды.\n";
  const reader = createInterface({ input, output, terminal: false });
  output.write(help);
  reader.on("line", (line) => {
    const command = line.trim().toLowerCase();
    if (command === "stop") {
      output.write(assistant.stopCurrentGeneration()
        ? "Остановка генерации запрошена. Бот продолжает работать.\n"
        : "Нет активной генерации для остановки.\n");
    } else if (command === "help") {
      output.write(help);
    } else if (command) {
      output.write("Неизвестная команда. Введите help.\n");
    }
  });
  return { close: () => reader.close() };
}
