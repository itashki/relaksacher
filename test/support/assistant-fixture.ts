/** @file Shared injected assistant test setup; each call owns its dependency state. */
import type { ChatRequest, ChatResponse, Message } from "ollama";
import type { AssistantOptions, MemoryStore, GenerationUpdate } from "../../src/types.ts";
import type { Fixture } from "./fixtures.ts";
import { createAssistant } from "./fixtures.ts";
import { createToolService } from "./fixtures.ts";

/**
 * Create fake model streams and capture requests and updates.
 * @param rounds Model chunks by round.
 * @param overrides Dependency overrides.
 * @returns Assistant fixture and captured events.
 */
export function setup(
  rounds: (Omit<Partial<ChatResponse>, "message"> & { message?: Partial<Message> })[][],
  overrides: Fixture<AssistantOptions> = {},
) {
  const requests: ChatRequest[] = [];
  const updates: (GenerationUpdate & { liveThinking?: string })[] = [];
  let aborted = 0;
  const memory: MemoryStore = {
    loadFursona: async () => null,
    saveFursona: async (_chatId, profile) => String(profile),
    loadMemory: async () => [{ id: 1, fact: "shared fact" }],
    buildMemoryPrompt: (facts, enabled) => (enabled ? facts.map((f) => f.fact).join("\n") : ""),
    addMemoryFact: async () => "saved",
    removeMemoryFact: async () => "removed",
  };
  const modelClient = {
    async chat(request: ChatRequest) {
      requests.push(structuredClone(request));
      const parts = rounds.shift();
      return {
        abort() {
          aborted++;
        },
        async *[Symbol.asyncIterator]() {
          yield* parts;
          if (!parts.some((part) => part.done))
            yield { done: true, done_reason: "stop", message: {} };
        },
      };
    },
  };
  const assistant = createAssistant({
    modelClient,
    memory,
    toolService: createToolService({ memory, fallbackClient: null }),
    model: "test",
    numCtx: 16384,
    timeoutMs: 1000,
    updateIntervalMs: 0,
    ...overrides,
  });
  return {
    assistant,
    requests,
    updates,
    memory,
    get aborted() {
      return aborted;
    },
    options: {
      conversation: [{ role: "user", content: "hello" }],
      onUpdate: (state: GenerationUpdate) => {
        updates.push(state);
      },
    },
  };
}
