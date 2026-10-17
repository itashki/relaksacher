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
export function createAssistant({
  modelClient, memory, toolService, model, numCtx, timeoutMs,
  updateIntervalMs = 0,
  facts = [],
  personality = "",
  logger = console,
  selectModel = () => ({ name: model }),
}) {
  const enqueue = createRequestQueue();
  return {
    createSession({
      conversation, background = [], context = {}, think = false, search,
      assistantName = "Релаксачер", platformInstructions = "", onUpdate = async () => {},
      onQueued = async () => {},
    }) {
      const selectedModel = selectModel();
      const generation = {
        stream: null,
        stopped: false,
        timedOut: false,
        stop() {
          this.stopped = true;
          this.stream?.abort();
        },
      };
      let started = false;
      return {
        stop: () => generation.stop(),
        async run() {
          if (started) throw new Error("Session already started");
          started = true;
          return enqueue(async () => {
            const useSearch = search !== false && toolService.searchEnabled;
            let useThinking = think;
            let text = search && !toolService.searchEnabled ? "⚠️ Поиск недоступен: не задан OLLAMA_API_KEY.\n\n" : "";
            let status = "";
            let thinkingLog = "";
            const flush = (final) => onUpdate({ text, status, final, modelAlias: selectedModel.alias });
            const timeoutTimer = setTimeout(() => {
              generation.timedOut = true;
              generation.stop();
            }, timeoutMs);
            let failed = false;
            let incompleteReason = null;
            try {
              await flush(false);
              const memoryFacts = context.scopeId ? await memory.loadMemory(context.scopeId) : [];
              const messages = buildMessages({ conversation, background, assistantName, platformInstructions, facts, personality,
                memoryPrompt: memory.buildMemoryPrompt(memoryFacts, Boolean(context.scopeId)), useSearch });
              const definitions = toolService.definitions({ scopeId: context.scopeId, search: useSearch });
              const toolsForRound = () => {
                const available = [...definitions, ...(!useThinking ? [THINK_TOOL] : [])];
                return available.length ? available : undefined;
              };
              let lastUpdate = 0;

              for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
                if (generation.stopped) break;

                const roundTools = round < MAX_TOOL_ROUNDS ? toolsForRound() : undefined;
                const guard = guardContext(messages, roundTools, selectedModel.numCtx ?? numCtx);
                if (guard.trimmed) {
                  console.log("Context guard: removed older history to fit the input budget");
                }
                const stream = await modelClient.chat({
                  model: selectedModel.name,
                  think: useThinking,
                  stream: true,
                  options: { num_ctx: selectedModel.numCtx ?? numCtx },
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
                  if (!roundContent.trim()) incompleteReason = "empty_answer";
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
                    result = await toolService.runTool(call, context);
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
                model: selectedModel.name,
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
            return { text, thinkingLog, model: selectedModel.name, modelAlias: selectedModel.alias, incompleteReason, failed, stopped: generation.stopped, timedOut: generation.timedOut };
          }, onQueued);
        },
      };
    },
  };
}
