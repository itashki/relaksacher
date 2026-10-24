/** @file Mouse packet decoding, keyboard isolation and visible-panel hit testing. */
import { expect, test } from "bun:test";
import {
  createMouseDecoder,
  panelAt,
  type MouseAction,
} from "../../src/adapters/terminal/mouse.ts";
import { buildDashboard } from "../../src/adapters/terminal/tui.ts";
import { createNavigation } from "../../src/adapters/terminal/scroll.ts";

test("SGR mouse reports are decoded across all byte boundaries without leaking keyboard shortcuts", () => {
  const packet = "\x1b[<64;115;30M";
  for (let split = 1; split < packet.length; split++) {
    const events: MouseAction[] = [],
      keys: Uint8Array[] = [];
    const input = createMouseDecoder(
      (event) => events.push(event),
      (data) => keys.push(data),
    );
    input.write(packet.slice(0, split));
    input.write(packet.slice(split));
    input.write("\x1b[<0;3;4M\x1b[<0;3;4m\x1b[<65;3;4M");
    expect(events).toEqual([
      { kind: "up", x: 115, y: 30 },
      { kind: "click", x: 3, y: 4 },
      { kind: "down", x: 3, y: 4 },
    ]);
    expect(keys).toHaveLength(0);
    input.close();
  }
});

test("legacy mouse coordinates and malformed reports never become keys, while UTF-8 and arrows survive", () => {
  const events: MouseAction[] = [],
    keys: Uint8Array[] = [];
  const input = createMouseDecoder(
    (event) => events.push(event),
    (data) => keys.push(data),
  );
  input.write(new Uint8Array([27, 91, 77, 32, 115, 104]));
  input.write("\x1b[<32;1;1M\x1b[<66;2;2M\x1b[<0;0;1M\x1b[<99999;1;1M\x1b[<bad;1;1M");
  input.write("\x1b[I\x1b[O\x1b[<35;2;2M");
  const keyboard = new TextEncoder().encode("я\x1b[A\t\x03");
  input.write(keyboard.subarray(0, 1));
  input.write(keyboard.subarray(1));
  expect(events).toEqual([{ kind: "click", x: 83, y: 72 }]);
  expect(new TextDecoder().decode(Bun.concatArrayBuffers(keys))).toBe("я\x1b[A\t\x03");
  input.close();
});

test("standalone Escape is released, while incomplete reports and closed decoders emit no late events", async () => {
  const events: MouseAction[] = [],
    keys: Uint8Array[] = [];
  const input = createMouseDecoder(
    (event) => events.push(event),
    (data) => keys.push(data),
  );
  input.write("\x1b");
  await Bun.sleep(120);
  expect(new TextDecoder().decode(Bun.concatArrayBuffers(keys))).toBe("\x1b");
  input.write("\x1b[<12;");
  await Bun.sleep(120);
  expect(keys).toHaveLength(1);
  input.write("\x1b[<64;");
  input.close();
  input.write("1;1M");
  await Bun.sleep(120);
  expect(events).toHaveLength(0);
  expect(keys).toHaveLength(1);
});

test("mouse hit regions follow rendered panels, expansion and resize while excluding the search row", () => {
  const navigation = createNavigation();
  for (const [columns, rows] of [
    [100, 30],
    [40, 12],
    [2, 2],
  ]) {
    for (const expanded of [false, true]) {
      navigation.expanded = expanded;
      const { regions } = buildDashboard(
        { current: null, queue: [] },
        {
          navigation,
          columns,
          rows,
          search: { panel: "answer", query: "", editing: true, match: -1, savedPosition: 0 },
        },
      );
      for (const region of regions) {
        if (!region.height) continue;
        expect(panelAt(regions, region.x, region.y)).toBe(region.id);
        expect(panelAt(regions, region.x + region.width - 1, region.y + region.height - 1)).toBe(
          region.id,
        );
      }
      expect(panelAt(regions, 0, 0)).toBeUndefined();
      expect(panelAt(regions, 1, rows)).toBeUndefined();
      expect(panelAt(regions, columns, 5)).toBeUndefined();
    }
  }
});
