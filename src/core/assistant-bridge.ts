/** @file Keep terminal subscriptions and local controls attached across assistant replacement. */
import type { Assistant, TerminalState } from "../types.ts";

/** Forward operator calls to the current assistant and rebind subscribers on replacement. */
export function createAssistantBridge(initial: Assistant) {
  let current = initial;
  const listeners = new Set<(state: TerminalState) => void>();
  let snapshot: TerminalState = { current: null, queue: [] };
  const publish = (state: TerminalState) => {
    snapshot = state;
    for (const listener of listeners) listener(structuredClone(state));
  };
  let unsubscribe = current.subscribeTerminal(publish);
  const assistant: Assistant = {
    subscribeTerminal(listener) {
      listeners.add(listener);
      listener(structuredClone(snapshot));
      return () => listeners.delete(listener);
    },
    stopCurrentGeneration: () => current.stopCurrentGeneration(),
    createSession: (options) => current.createSession(options),
    observeMessage: (message) => current.observeMessage(message),
    considerMessage: (message) => current.considerMessage(message),
    flushObservations: () => current.flushObservations(),
    stopObserving: () => current.stopObserving(),
  };
  return {
    assistant,
    replace(next: Assistant) {
      unsubscribe();
      current = next;
      unsubscribe = current.subscribeTerminal(publish);
    },
    close() {
      unsubscribe();
      listeners.clear();
    },
  };
}
