/** @file Implementation of core/tools. */
import { truncate } from "./text.js";

const MEMORY_TOOLS = [
  {
    type: "function",
    function: {
      name: "remember",
      description:
        "Сохраняет факт, правило или шутку в долговременную память сервера, чтобы помнить их в будущих разговорах.",
      parameters: {
        type: "object",
        required: ["fact"],
        properties: {
          fact: {
            type: "string",
            description: "Короткая самодостаточная запись (до 300 символов)",
          },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "forget",
      description: "Удаляет запись из памяти сервера по её id.",
      parameters: {
        type: "object",
        required: ["id"],
        properties: {
          id: { type: "number", description: "id записи из списка памяти" },
        },
      },
    },
  },
];


// Сколько первых результатов поиска сразу подгружать целиком (полный текст страницы).
const SEARCH_FETCH_TOP = 2;

const TOOLS = [
  {
    type: "function",
    function: {
      name: "web_search",
      description:
        "Поиск в интернете. Используй для актуальной информации, новостей, фактов, которых ты не знаешь.",
      parameters: {
        type: "object",
        required: ["query"],
        properties: {
          query: { type: "string", description: "Поисковый запрос" },
          max_results: {
            type: "number",
            description: "Сколько результатов вернуть (1-8, по умолчанию 5)",
          },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "web_fetch",
      description:
        "Загружает содержимое веб-страницы по URL (например, одной из ссылок из результатов поиска).",
      parameters: {
        type: "object",
        required: ["url"],
        properties: {
          url: { type: "string", description: "Полный URL страницы" },
        },
      },
    },
  },
];


/**
 * Expose memory tools and optionally Ollama cloud web tools.
 * @param {object} options Dependencies.
 * @param {import("ollama").Ollama|null} [options.searchClient] Authenticated cloud client.
 * @param {import("../types.js").MemoryStore} options.memory Persistent fact operations.
 * @returns {{runTool: function(import("../types.js").ToolCall, import("../types.js").RequestContext): Promise<string>, searchEnabled: boolean, definitions: function({scopeId: string=, search: boolean=}): import("../types.js").ToolDefinition[]}} Tool service.
 */
export function createToolService({ searchClient = null, memory }) {
  const { addMemoryFact, removeMemoryFact } = memory;
  // Выполняет вызов инструмента и возвращает строку для модели.
  /**
   * Execute a tool; failures become textual results for the model.
   * @param {import("../types.js").ToolCall} call Requested function and arguments.
   * @param {import("../types.js").RequestContext} context Memory scope and attribution.
   * @returns {Promise<string>} Tool output or a readable failure description.
   */
  async function runTool(call, context) {
    const { name } = call.function;
    const args = call.function.arguments ?? {};

    console.log(`[tool] ${name}`, JSON.stringify(args));

    try {
      if (name === "remember" || name === "forget") {
        // Память работает только на серверах и только в рамках текущего сервера.
        if (!context?.scopeId) return "Память доступна только на сервере.";
        const result =
          name === "remember"
            ? await addMemoryFact(context.scopeId, args.fact, context.authorName)
            : await removeMemoryFact(context.scopeId, args.id);
        console.log(`[tool] ${name} -> ${result}`);
        return result;
      }

      if (name === "web_search") {
        const response = await searchClient.webSearch({
          query: String(args.query ?? ""),
          max_results: Math.min(Math.max(Number(args.max_results) || 5, 1), 8),
        });
        const results = response.results;

        // Модели поменьше редко сами вызывают web_fetch и отвечают по одним
        // сниппетам, поэтому полный текст первых страниц подгружаем за неё.
        const pages = await Promise.allSettled(
          results
            .slice(0, SEARCH_FETCH_TOP)
            .map((result) => searchClient.webFetch({ url: result.url })),
        );

        return JSON.stringify(
          results.map((result, index) => {
            const page =
              pages[index]?.status === "fulfilled" ? pages[index].value : null;
            return {
              title: result.title,
              url: result.url,
              content: page
                ? truncate(page.content, 3500)
                : truncate(result.content, 1500),
            };
          }),
        );
      }

      if (name === "web_fetch") {
        const response = await searchClient.webFetch({
          url: String(args.url ?? ""),
        });
        return JSON.stringify({
          title: response.title,
          content: truncate(response.content, 6000),
          links: (response.links ?? []).slice(0, 10),
        });
      }

      return `Неизвестный инструмент: ${name}`;
    } catch (error) {
      console.error(`Tool ${name} failed:`, error);
      return `Ошибка выполнения инструмента ${name}: ${error.message}`;
    }
  }

  return {
    runTool,
    searchEnabled: Boolean(searchClient),
    definitions: ({ scopeId, search }) => [
      ...(scopeId ? MEMORY_TOOLS : []),
      ...(search && searchClient ? TOOLS : []),
    ],
  };
}
