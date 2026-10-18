/** @file Local terminal controls for a running bot. */
import { createInterface } from "node:readline";
import { createTui } from "./tui.js";

/**
 * Listen for operator commands without stopping the messenger adapters.
 * @param {object} options Dependencies.
 * @param {import("../types.js").Assistant} options.assistant Shared assistant.
 * @param {NodeJS.ReadableStream} [options.input] Command input.
 * @param {NodeJS.WritableStream} [options.output] Status output.
 * @returns {{close: function(): void}} Terminal lifecycle.
 */
export function createCliControls({ assistant, input = process.stdin, output = process.stdout }) {
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
