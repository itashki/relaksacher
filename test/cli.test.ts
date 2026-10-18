import test from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { createCliControls } from "./fixtures.ts";

test("CLI handles stop, idle state, help and closes its input listener", () => {
  const input = new PassThrough();
  const output = new PassThrough();
  let text = "";
  output.on("data", (chunk) => { text += chunk; });
  let calls = 0;
  const controls = createCliControls({ input, output, assistant: {
    stopCurrentGeneration() { return ++calls === 1; },
  } });
  input.write(" STOP \nstop\nhelp\nunknown\n\n");
  assert.equal(calls, 2);
  assert.match(text, /Остановка генерации запрошена/);
  assert.match(text, /Нет активной генерации/);
  assert.match(text, /Неизвестная команда/);
  assert.equal(text.match(/CLI:/g).length, 2);
  controls.close();
  input.write("stop\n");
  assert.equal(calls, 2);
  input.end();
  output.end();
});
