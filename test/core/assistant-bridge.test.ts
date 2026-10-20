/** @file Operator subscriptions and stop controls survive replacing the assistant. */
import { expect, test } from "bun:test";
import { createAssistantBridge } from "../../src/core/assistant-bridge.ts";
import { fixture } from "../support/fixtures.ts";
import type { Assistant, TerminalState } from "../../src/types.ts";

test("assistant bridge detaches old subscriptions and forwards controls to the replacement", () => {
  const events: string[] = [];
  const create = (name: string) =>
    fixture<Assistant>({
      subscribeTerminal(listener) {
        listener({ current: null, queue: [], last: { id: name === "old" ? 1 : 2 } });
        return () => {
          events.push(`unsubscribe:${name}`);
        };
      },
      stopCurrentGeneration() {
        events.push(`stop:${name}`);
        return true;
      },
    });
  const bridge = createAssistantBridge(create("old"));
  const snapshots: TerminalState[] = [];
  const unsubscribe = bridge.assistant.subscribeTerminal((state) => {
    snapshots.push(state);
  });
  bridge.assistant.stopCurrentGeneration();
  bridge.replace(create("new"));
  bridge.assistant.stopCurrentGeneration();
  expect(snapshots.map((state) => state.last.id)).toEqual([1, 2]);
  unsubscribe();
  bridge.close();
  expect(events).toEqual(["stop:old", "unsubscribe:old", "stop:new", "unsubscribe:new"]);
});
