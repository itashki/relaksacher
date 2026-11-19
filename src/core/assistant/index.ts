/** @file Coordinate cancellable model sessions, shared inference scheduling and background observation. */
import { createMemoryObserver } from "./observer.ts";
import { createSpontaneousPolicy } from "./spontaneous.ts";
import { guardContext, ContextLimitError } from "./context.ts";
import { createRequestQueue } from "../queue.ts";
import { createRepetitionDetector } from "./repetition.ts";
import { buildMessages } from "./prompt.ts";
import { createModelRouter, createModelChat, requiresNonThinking } from "./models.ts";
import { cleanAssistantText, incompleteExplanation } from "./output.ts";

const MAX_TOOL_ROUNDS = 5;
const THINK_TOOL = {
  type: "function",
  function: {
    name: "enable_thinking",
    description:
      "Включает режим размышлений перед ответом, если пользователь просит подумать, тщательно проанализировать или перепроверить рассуждение. После вызова продолжи решение задачи.",
    parameters: { type: "object", properties: {} },
  },
};

// A session is independent of any chat platform. onUpdate receives snapshots;
// stop() can be used by a CLI, HTTP request, or a chat adapter.
/**
 * Create a platform-independent assistant with one shared FIFO generation queue.
 * @param options Injected clients and policies.
 * @returns Assistant factory; no network calls until run().
 */
export function createAssistant({
  modelClient,
  memory,
  toolService,
  model,
  visionModel,
  numCtx,
  timeoutMs,
  updateIntervalMs = 0,
  facts = [],
  personality = "",
  logger = console,
  supervisor,
  autoMemory = true,
  autoMemoryCooldownMs = 120000,
  autoMemoryCheckIntervalMs = 60000,
  spontaneous = {},
}: import("../../types.ts").AssistantOptions): import("../../types.ts").Assistant {
  const modelForConversation = createModelRouter(model, visionModel);
  const chat = createModelChat(modelClient);
  let repliesPaused = false;
  const enqueue = createRequestQueue();
  let activeGeneration: { stopped: boolean; stop(): void };
  const terminalListeners = new Set<(state: import("../../types.ts").TerminalState) => void>();
  const pendingRequests = new Map();
  let nextRequestId = 0;
  let currentRequest: import("../../types.ts").TerminalRequest = null;
  let lastRequest: import("../../types.ts").TerminalRequest = null;
  const terminalState = () => ({
    current: currentRequest,
    last: lastRequest,
    queue: [...pendingRequests.values()],
  });
  /** Notify local terminal subscribers with an isolated snapshot of generation and queue state. */
  function publishTerminal() {
    for (const listener of terminalListeners) {
      try {
        listener(structuredClone(terminalState()));
      } catch {
        /* UI cannot interrupt generation. */
      }
    }
  }
  const observer = createMemoryObserver({
    supervisor,
    memory,
    enqueue,
    logger,
    autoMemory,
    autoMemoryCooldownMs,
    autoMemoryCheckIntervalMs,
  });
  const consider = createSpontaneousPolicy({
    ...spontaneous,
    enqueue,
    decide: supervisor?.decideReply
      ? (message) => supervisor.decideReply(message, observer.signal)
      : undefined,
  });
  return {
    runExclusive: (task) => enqueue(task),
    repliesPaused: () => repliesPaused,
    setRepliesPaused(paused) {
      repliesPaused = paused;
    },
    /** Subscribe to local operator state, including reasoning; never sent to messenger callbacks. */
    subscribeTerminal(listener) {
      terminalListeners.add(listener);
      listener(structuredClone(terminalState()));
      return () => terminalListeners.delete(listener);
    },
    /** Cancel the running reply without cancelling queued requests. @returns Whether cancellation was requested. */
    stopCurrentGeneration() {
      if (!activeGeneration || activeGeneration.stopped) return false;
      activeGeneration.stop();
      return true;
    },
    /** @param message Scoped group message. @returns Optional contribution angle. */
    considerMessage(message: any) {
      return observer.closed() || repliesPaused ? Promise.resolve(null) : consider(message);
    },
    /**
     * Buffer an ordinary group statement for conservative, silent fact extraction.
     * @param message Scoped statement.
     */
    observeMessage(message: {
      scopeId: string;
      roomId: string;
      id: string;
      text: string;
      authorName: string;
    }) {
      observer.observe(message);
    },
    flushObservations: () => observer.flush(),
    /** Stop background extraction and discard unprocessed messages. @returns */
    stopObserving() {
      observer.stop();
    },
    /**
     * Capture one request; execution with the configured model starts only with run().
     * @param options Conversation and delivery hooks.
     * @returns Single-use cancellable session.
     */
    createSession({
      conversation,
      background = [],
      context = {},
      think = false,
      assistantName = "Релаксачер",
      platformInstructions = "",
      onUpdate = async () => {},
      onQueued = async () => {},
      onToolCall,
    }: import("../../types.ts").SessionOptions): import("../../types.ts").Session {
      const model = modelForConversation(conversation);
      const forceNonThinking = requiresNonThinking(model);
      const toolContext = { ...context, imageState: { candidates: new Map(), sent: false } };
      const generation = {
        stream: null as import("../../types.ts").ModelStream | null,
        controller: new AbortController(),
        stopped: false,
        timedOut: false,
        /**
         * Mark the session cancelled and abort the current stream if one exists.
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
         * @returns Completed or interrupted result.
         * @throws {Error} On repeated execution or failed final delivery.
         */
        async run() {
          if (started) throw new Error("Session already started");
          started = true;
          const disabled = async (): Promise<import("../../types.ts").GenerationResult> => {
            const text = "Ответы ИИ временно отключены.";
            await onUpdate({ text, status: "", final: true });
            return {
              text,
              thinkingLog: "",
              model,
              incompleteReason: null,
              failed: false,
              stopped: false,
              timedOut: false,
            };
          };
          if (repliesPaused) return disabled();
          const requestId = ++nextRequestId;
          const request = {
            id: requestId,
            author: context.authorName ?? "Неизвестный автор",
            scope: context.scopeId ?? "Личный чат",
            model,
            prompt: conversation.at(-1)?.content ?? "",
            text: "",
            thinking: "",
            status: "В очереди",
            queuedAt: Date.now(),
          };
          pendingRequests.set(requestId, request);
          publishTerminal();
          return enqueue(async () => {
            if (repliesPaused) return disabled();
            activeGeneration = generation;
            pendingRequests.delete(requestId);
            currentRequest = { ...request, startedAt: Date.now(), status: "Подготовка" };
            publishTerminal();
            let useThinking = !forceNonThinking && think;
            let text = "";
            let status: import("../../types.ts").GenerationUpdate["status"] = "";
            let thinkingLog = "";
            let failed = false;
            let incompleteReason: string | null = null;
            /**
             * Deliver a plain answer snapshot without reasoning text.
             * @param final Whether generation is complete.
             * @returns Adapter delivery result.
             */
            const updateTerminal = (final: boolean = false) => {
              if (currentRequest?.id !== requestId) return;
              currentRequest = {
                ...currentRequest,
                text: cleanAssistantText(text, final),
                thinking: thinkingLog,
                status: final
                  ? generation.stopped
                    ? "Остановлена"
                    : failed
                      ? "Ошибка"
                      : incompleteReason
                        ? "Не завершена"
                        : "Завершена"
                  : generation.stopped
                    ? "Остановка"
                    : status
                      ? `Инструмент: ${status.function.name}`
                      : "Генерация",
              };
              if (final) lastRequest = currentRequest;
              publishTerminal();
            };
            const flush = (final: boolean) => {
              updateTerminal(final);
              return onUpdate({ text: cleanAssistantText(text, final), status, final });
            };
            const timeoutTimer = setTimeout(() => {
              generation.timedOut = true;
              generation.stop();
            }, timeoutMs);
            try {
              await flush(false);
              if (!forceNonThinking && supervisor && !think && !generation.stopped) {
                try {
                  useThinking = await supervisor.decideThinking(
                    conversation,
                    generation.controller.signal,
                  );
                  logger.info("[router]", { think: useThinking, model });
                } catch (error) {
                  if (!generation.stopped)
                    console.warn("Thinking router failed; using non-thinking mode:", error.message);
                }
              }
              const memoryFacts = context.scopeId ? await memory.loadMemory(context.scopeId) : [];
              const messages = buildMessages({
                conversation,
                background,
                assistantName,
                platformInstructions,
                facts,
                personality,
                fursona: context.chatId ? await memory.loadFursona(context.chatId) : undefined,
                memoryPrompt: memory.buildMemoryPrompt(memoryFacts, Boolean(context.scopeId)),
              });
              const definitions = toolService.definitions({
                chatId: context.chatId,
                scopeId: context.scopeId,
                history: typeof context.readHistory === "function",
                images: typeof context.sendImage === "function",
              });
              /**
               * List currently available tools, omitting the thinking switch once enabled.
               * @returns Available schemas.
               */
              const toolsForRound = () => {
                const available = [
                  ...definitions,
                  ...(!forceNonThinking && !supervisor && !useThinking ? [THINK_TOOL] : []),
                ];
                return available.length ? available : undefined;
              };
              let lastUpdate = 0;
              let recoveringRepetition = false;

              for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
                if (generation.stopped) break;

                const roundTools =
                  !recoveringRepetition && round < MAX_TOOL_ROUNDS ? toolsForRound() : undefined;
                const guard = guardContext(messages, roundTools, numCtx);
                if (guard.trimmed) {
                  console.log("Context guard: removed older history to fit the input budget");
                }
                const stream = await chat({
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

                const thinkingRepetition = createRepetitionDetector();
                const contentRepetition = createRepetitionDetector();
                let repetition: "thinking" | "content" | null = null;
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
                  if (contentRepetition.push(delta)) repetition = "content";
                  else if (thinkingRepetition.push(thinkingDelta)) repetition = "thinking";
                  if (repetition) {
                    stream.abort();
                    break;
                  }
                  if (thinkingDelta || delta) updateTerminal();

                  if (delta && Date.now() - lastUpdate >= updateIntervalMs) {
                    lastUpdate = Date.now();
                    await flush(false);
                  }
                }

                if (generation.stopped) break;
                if (repetition) {
                  if (repetition === "thinking" && !recoveringRepetition && !roundContent.trim()) {
                    recoveringRepetition = true;
                    useThinking = false;
                    messages.push({
                      role: "user",
                      content:
                        "Заверши размышления. Сразу дай краткий окончательный ответ на исходный запрос без повторений и вызовов инструментов.",
                    });
                    round--;
                    continue;
                  }
                  incompleteReason = "repetition";
                  break;
                }
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
                  if (!cleanAssistantText(roundContent).trim() && !toolContext.imageState.sent)
                    incompleteReason = "empty_answer";
                  break;
                }
                if (round === MAX_TOOL_ROUNDS) {
                  incompleteReason = "tool_limit";
                  break;
                }

                messages.push({
                  role: "assistant",
                  content: cleanAssistantText(roundContent),
                  // При tool calling Ollama рекомендует возвращать рассуждения модели обратно.
                  thinking: roundThinking || undefined,
                  tool_calls: toolCalls,
                });

                for (const call of toolCalls) {
                  if (generation.stopped) break;

                  status = call;
                  await flush(false);
                  lastUpdate = Date.now();

                  try {
                    onToolCall?.(call);
                  } catch (error) {
                    console.warn("Tool call logging failed:", error);
                  }
                  let result;
                  if (call.function.name === "enable_thinking") {
                    useThinking = !forceNonThinking;
                    result = forceNonThinking
                      ? "Режим размышлений отключён для этой модели. Продолжи выполнение запроса."
                      : "Режим размышлений включён. Продолжи выполнение текущего запроса.";
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
              if (thinkingLog.trim())
                logger.info("[thinking]", {
                  model,
                  scopeId: context.scopeId,
                  authorName: context.authorName,
                  text: thinkingLog,
                });
            }

            text = cleanAssistantText(text);
            if (failed) {
              text += text
                ? "\n\n⚠️ Ошибка при генерации ответа."
                : "Произошла ошибка при обработке запроса.";
            } else if (generation.timedOut) {
              text += text
                ? "\n\n⚠️ Превышено время ожидания."
                : "Превышено время ожидания ответа.";
            } else if (generation.stopped) {
              text = text.trim()
                ? `${text}\n\n⚠️ Ответ не завершён: генерация остановлена.`
                : "Генерация остановлена.";
            } else if (incompleteReason) {
              const explanation = incompleteExplanation(incompleteReason);
              text += `${text ? "\n\n" : ""}⚠️ Ответ не завершён: ${explanation}.`;
            }

            await flush(true);
            return {
              text,
              thinkingLog,
              model,
              incompleteReason,
              failed,
              stopped: generation.stopped,
              timedOut: generation.timedOut,
            };
          }, onQueued).finally(() => {
            pendingRequests.delete(requestId);
            if (currentRequest?.id === requestId) {
              lastRequest = currentRequest;
              currentRequest = null;
            }
            if (activeGeneration === generation) activeGeneration = undefined;
            publishTerminal();
          });
        },
      };
    },
  };
}
