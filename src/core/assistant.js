import { createSpontaneousPolicy } from "./spontaneous.js";
/** @file Implementation of core/assistant. */
import { guardContext, ContextLimitError } from "./context.js";
import { createRequestQueue } from "./queue.js";
import { buildMessages } from "./prompt.js";

const MAX_TOOL_ROUNDS = 5;
const THINK_TOOL = {
  type: "function",
  function: {
    name: "enable_thinking",
    description: "Включает режим размышлений перед ответом, если пользователь просит подумать, тщательно проанализировать или перепроверить рассуждение. После вызова продолжи решение задачи.",
    parameters: { type: "object", properties: {} },
  },
};

// A session is independent of any chat platform. onUpdate receives snapshots;
// stop() can be used by a CLI, HTTP request, or a chat adapter.
/**
 * Create a platform-independent assistant with one shared FIFO generation queue.
 * @param {import("../types.js").AssistantOptions} options Injected clients and policies.
 * @returns {import("../types.js").Assistant} Assistant factory; no network calls until run().
 */
export function createAssistant({
  modelClient, memory, toolService, model, numCtx, timeoutMs,
  updateIntervalMs = 0,
  facts = [],
  personality = "",
  logger = console,
  supervisor,
  autoMemory = true,
  autoMemoryCooldownMs = 120000,
  autoMemoryCheckIntervalMs = 60000,
  spontaneous = {},
}) {
  const enqueue = createRequestQueue();
  const observations = new Map();
  const memoryTiming = new Map();
  /** @param {string} scopeId Group namespace. @returns {boolean} Whether background memory is eligible now. */
  function canObserve(scopeId) {
    const state = memoryTiming.get(scopeId);
    return !state || (Date.now() - state.checked >= autoMemoryCheckIntervalMs && Date.now() - state.saved >= autoMemoryCooldownMs);
  }
  const observationController = new AbortController();
  let observationTimer;
  let observationJob;
  let observerClosed = false;
  /** Schedule one bounded batch; background inference shares the generation queue. */
  function scheduleObservation() {
    if (!observationTimer && !observerClosed) {
      observationTimer = setTimeout(() => {
        observationTimer = undefined;
        void flushObservations();
      }, 5000);
      observationTimer.unref?.();
    }
  }
  /** @returns {Promise<void>} Process one room batch without overlapping user generation. */
  function flushObservations() {
    clearTimeout(observationTimer);
    observationTimer = undefined;
    if (observationJob) return observationJob;
    if (!observations.size || observerClosed) return Promise.resolve();
    const [key, entry] = observations.entries().next().value;
    observations.delete(key);
    observationJob = enqueue(async () => {
      if (observerClosed || !canObserve(entry.scopeId)) return;
      const timing = memoryTiming.get(entry.scopeId) ?? { checked: -Infinity, saved: -Infinity };
      timing.checked = Date.now();
      memoryTiming.delete(entry.scopeId);
      memoryTiming.set(entry.scopeId, timing);
      if (memoryTiming.size > 500) memoryTiming.delete(memoryTiming.keys().next().value);
      try {
        const extracted = await supervisor.extractFacts(entry.messages.slice(-8), observationController.signal);
        for (const fact of extracted.slice(0, 1)) {
          if (observerClosed) break;
          await memory.addMemoryFact(entry.scopeId, fact.text, fact.authorName);
          timing.saved = Date.now();
        }
        if (extracted.length) logger.info("[auto-memory]", { scopeId: entry.scopeId, count: extracted.length });
      } catch (error) {
        if (!observerClosed) console.warn("Automatic memory extraction failed:", error.message);
      }
    }, undefined, { priority: -1 }).finally(() => {
      observationJob = undefined;
      if (observations.size) scheduleObservation();
    });
    return observationJob;
  }
  const consider = createSpontaneousPolicy({
    ...spontaneous, enqueue,
    decide: supervisor?.decideReply ? (message) => supervisor.decideReply(message, observationController.signal) : undefined,
  });
  return {
    /** @param {object} message Scoped group message. @returns {Promise<{angle: string}|null>} Optional contribution angle. */
    considerMessage(message) { return observerClosed ? Promise.resolve(null) : consider(message); },
    /**
     * Buffer an ordinary group statement for conservative, silent fact extraction.
     * @param {{scopeId: string, roomId: string, id: string, text: string, authorName: string}} message Scoped statement.
     * @returns {void}
     */
    observeMessage(message) {
      if (!supervisor || !autoMemory || observerClosed || !message.scopeId || !message.text?.trim() || !canObserve(message.scopeId)) return;
      const key = `${message.scopeId}:${message.roomId}`;
      if (!observations.has(key) && observations.size >= 50) return;
      const entry = observations.get(key) ?? { scopeId: message.scopeId, messages: [] };
      if (!entry.messages.some((item) => item.id === message.id)) entry.messages.push({
        id: message.id, text: message.text.slice(0, 900), authorName: message.authorName,
      });
      entry.messages = entry.messages.slice(-8);
      observations.set(key, entry);
      scheduleObservation();
    },
    flushObservations,
    /** Stop background extraction and discard unprocessed messages. @returns {void} */
    stopObserving() {
      observerClosed = true;
      clearTimeout(observationTimer);
      observations.clear();
      observationController.abort();
    },
    /**
     * Capture one request; execution with the configured model starts only with run().
     * @param {import("../types.js").SessionOptions} options Conversation and delivery hooks.
     * @returns {import("../types.js").Session} Single-use cancellable session.
     */
    createSession({
      conversation, background = [], context = {}, think = false, search,
      assistantName = "Релаксачер", platformInstructions = "", onUpdate = async () => {},
      onQueued = async () => {},
    }) {
      const toolContext = { ...context, imageState: { candidates: new Map(), sent: false } };
      const generation = {
        stream: null,
        controller: new AbortController(),
        stopped: false,
        timedOut: false,
        /**
         * Mark the session cancelled and abort the current stream if one exists.
         * @returns {void}
         */
        stop() {
          this.stopped = true;
          this.controller.abort();
          this.stream?.abort();
        },
      };
      let started = false;
      return {
        stop: () => generation.stop(),
        /**
         * Run this session once through the shared queue; waiting does not consume its deadline.
         * @returns {Promise<import("../types.js").GenerationResult>} Completed or interrupted result.
         * @throws {Error} On repeated execution or failed final delivery.
         */
        async run() {
          if (started) throw new Error("Session already started");
          started = true;
          return enqueue(async () => {
            const useSearch = search !== false && toolService.searchEnabled;
            let useThinking = think;
            let text = search && !toolService.searchEnabled ? "⚠️ Поиск недоступен.\n\n" : "";
            let status = "";
            let thinkingLog = "";
            /**
             * Deliver a plain answer snapshot without reasoning text.
             * @param {boolean} final Whether generation is complete.
             * @returns {void|Promise<void>} Adapter delivery result.
             */
            const flush = (final) => onUpdate({ text, status, final });
            const timeoutTimer = setTimeout(() => {
              generation.timedOut = true;
              generation.stop();
            }, timeoutMs);
            let failed = false;
            let incompleteReason = null;
            try {
              await flush(false);
              if (supervisor && !think && !generation.stopped) {
                try {
                  useThinking = await supervisor.decideThinking(conversation, generation.controller.signal);
                  logger.info("[router]", { think: useThinking, model });
                } catch (error) {
                  if (!generation.stopped) console.warn("Thinking router failed; using non-thinking mode:", error.message);
                }
              }
              const memoryFacts = context.scopeId ? await memory.loadMemory(context.scopeId) : [];
              const messages = buildMessages({ conversation, background, assistantName, platformInstructions, facts, personality,
                memoryPrompt: memory.buildMemoryPrompt(memoryFacts, Boolean(context.scopeId)), useSearch });
              const definitions = toolService.definitions({ scopeId: context.scopeId, search: useSearch, history: typeof context.readHistory === "function", images: typeof context.sendImage === "function" });
              /**
               * List currently available tools, omitting the thinking switch once enabled.
               * @returns {import("../types.js").ToolDefinition[]|undefined} Available schemas.
               */
              const toolsForRound = () => {
                const available = [...definitions, ...(!supervisor && !useThinking ? [THINK_TOOL] : [])];
                return available.length ? available : undefined;
              };
              let lastUpdate = 0;

              for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
                if (generation.stopped) break;

                const roundTools = round < MAX_TOOL_ROUNDS ? toolsForRound() : undefined;
                const guard = guardContext(messages, roundTools, numCtx);
                if (guard.trimmed) {
                  console.log("Context guard: removed older history to fit the input budget");
                }
                const stream = await modelClient.chat({
                  model,
                  think: useThinking,
                  stream: true,
                  options: { num_ctx: numCtx },
                  // В последнем раунде инструменты отключаем, чтобы модель точно ответила.
                  tools: roundTools,
                  messages,
                });

                generation.stream = stream;
                // The session may have been stopped while waiting for the stream.
                if (generation.stopped) {
                  stream.abort();
                  break;
                }

                let roundContent = "";
                let roundThinking = "";
                let roundHasThinking = false;
                let separated = false;
                const toolCalls = [];
                let streamDone = false;
                let doneReason;

                for await (const part of stream) {
                  if (generation.stopped) break;

                  if (part.done) {
                    streamDone = true;
                    doneReason = part.done_reason;
                  }

                  const thinkingDelta = part.message?.thinking ?? "";
                  if (thinkingDelta) {
                    roundThinking += thinkingDelta;
                    // Раунды (например, до и после поиска) разделяем чертой.
                    if (!roundHasThinking && thinkingLog) {
                      thinkingLog += "\n\n---\n\n";
                    }
                    roundHasThinking = true;
                    thinkingLog += thinkingDelta;
                  }

                  const delta = part.message?.content ?? "";
                  if (delta) {
                    // Отделяем текст после поиска от текста до него.
                    if (!separated && round > 0 && text) text += "\n\n";
                    separated = true;
                    text += delta;
                    roundContent += delta;
                  }

                  if (part.message?.tool_calls?.length) {
                    toolCalls.push(...part.message.tool_calls);
                  }

                  if (delta && Date.now() - lastUpdate >= updateIntervalMs) {
                    lastUpdate = Date.now();
                    await flush(false);
                  }
                }


                if (generation.stopped) break;
                if (!streamDone) {
                  incompleteReason = "stream_interrupted";
                  break;
                }
                if (doneReason === "length") {
                  incompleteReason = "length";
                  break;
                }
                if (doneReason && !["stop", "tool_calls"].includes(doneReason)) {
                  incompleteReason = doneReason;
                  break;
                }
                if (toolCalls.length === 0) {
                  if (!roundContent.trim() && !toolContext.imageState.sent) incompleteReason = "empty_answer";
                  break;
                }
                if (round === MAX_TOOL_ROUNDS) {
                  incompleteReason = "tool_limit";
                  break;
                }

                messages.push({
                  role: "assistant",
                  content: roundContent,
                  // При tool calling Ollama рекомендует возвращать рассуждения модели обратно.
                  thinking: roundThinking || undefined,
                  tool_calls: toolCalls,
                });

                for (const call of toolCalls) {
                  if (generation.stopped) break;

                  status = call;
                  await flush(false);
                  lastUpdate = Date.now();

                  let result;
                  if (call.function.name === "enable_thinking") {
                    useThinking = true;
                    result = "Режим размышлений включён. Продолжи выполнение текущего запроса.";
                  } else {
                    result = await toolService.runTool(call, toolContext);
                  }
                  messages.push({
                    role: "tool",
                    content: result,
                    tool_name: call.function.name,
                  });
                }

                status = "";
              }
            } catch (error) {
              // Abort по кнопке/таймауту бросает AbortError — это не ошибка.
              if (error instanceof ContextLimitError) {
                incompleteReason = "context_limit";
              } else if (!generation.stopped) {
                failed = true;
                console.error("Failed to get response from Ollama:", error);
              }
            } finally {
              clearTimeout(timeoutTimer);
              status = "";
              generation.stream?.abort();
              if (thinkingLog.trim()) logger.info("[thinking]", {
                model,
                scopeId: context.scopeId,
                authorName: context.authorName,
                text: thinkingLog,
              });
            }

            if (failed) {
              text += text
                ? "\n\n⚠️ Ошибка при генерации ответа."
                : "Произошла ошибка при обработке запроса.";
            } else if (generation.timedOut) {
              text += text
                ? "\n\n⚠️ Превышено время ожидания."
                : "Превышено время ожидания ответа.";
            } else if (generation.stopped) {
              text = text.trim() ? `${text}\n\n⚠️ Ответ не завершён: генерация остановлена.` : "Генерация остановлена.";
            } else if (incompleteReason) {
              const explanation = incompleteReason === "context_limit"
                ? "текущий запрос и обязательный контекст слишком велики; сократи запрос или начни новый диалог"
                : incompleteReason === "length"
                ? "достигнут лимит генерации"
                : incompleteReason === "tool_limit"
                  ? "достигнут лимит вызовов инструментов"
                  : incompleteReason === "empty_answer"
                    ? "модель не вернула текст ответа"
                    : "не подтверждено нормальное завершение генерации";
              text += `${text ? "\n\n" : ""}⚠️ Ответ не завершён: ${explanation}.`;
            }

            await flush(true);
            return { text, thinkingLog, model, incompleteReason, failed, stopped: generation.stopped, timedOut: generation.timedOut };
          }, onQueued);
        },
      };
    },
  };
}
