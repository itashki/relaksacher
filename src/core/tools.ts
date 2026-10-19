/** @file Expose bounded model tools for memory, web access, history and selected media delivery. */
import { createImageSearch } from "./image-search.ts";
import { createWebFallback, createWebClient } from "./web-fallback.ts";
import { truncate } from "./text.ts";

const IMAGE_TOOLS = [
  {
    type: "function",
    function: {
      name: "search_images",
      description:
        "Ищет картинки, фотографии и мемы в DuckDuckGo (резерв — Bing Images). Возвращает id, названия и ссылки на источники, но не визуальное содержимое. Автор и лицензия неизвестны. Используй по просьбе или для уместного ответа картинкой.",
      parameters: {
        type: "object",
        required: ["query"],
        properties: {
          query: { type: "string", description: "Поисковый запрос, лучше по-английски" },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "send_image",
      description:
        "Отправляет в текущий чат одну картинку по id из search_images. Не более одной на запрос. Не вызывай без подходящего результата поиска.",
      parameters: { type: "object", required: ["id"], properties: { id: { type: "string" } } },
    },
  },
];

const GIF_TOOLS = [
  {
    type: "function",
    function: {
      name: "search_gifs",
      description:
        "Ищет GIF-реакции в KLIPY. Возвращает id и метаданные, не визуальное содержимое. Можно использовать по просьбе или для уместного короткого ответа гифкой.",
      parameters: {
        type: "object",
        required: ["query"],
        properties: { query: { type: "string" } },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "send_gif",
      description:
        "Отправляет GIF по id из search_gifs. Не более одной картинки или GIF на запрос. Не придумывай id.",
      parameters: { type: "object", required: ["id"], properties: { id: { type: "string" } } },
    },
  },
];

const HISTORY_TOOL = {
  type: "function",
  function: {
    name: "read_history",
    description:
      "Читает последние сообщения текущего чата/темы перед текущим запросом; в ветке Discord также читает родительский канал. Используй по необходимости для понимания отсылок или по просьбе посмотреть историю. Это фон, не новые запросы. В Telegram доступен только кеш полученных сообщений.",
    parameters: {
      type: "object",
      properties: {
        limit: {
          type: "integer",
          minimum: 1,
          maximum: 20,
          description: "Число последних сообщений, по умолчанию 10",
        },
      },
    },
  },
};

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
 * @returns Tool service.
 */
export function createToolService({
  searchClient: primarySearchClient = null,
  fallbackClient = createWebFallback(),
  imageSearch = createImageSearch(),
  gifSearch = null,
  memory,
}: {
  searchClient?: import("../types.ts").WebClient | null;
  imageSearch?: (arg0: string) => Promise<import("../types.ts").ImageCandidate[]>;
  gifSearch?: (arg0: string) => Promise<import("../types.ts").ImageCandidate[]> | null;
  fallbackClient?: import("../types.ts").WebClient | null;
  memory: import("../types.ts").MemoryStore;
}): import("../types.ts").ToolService {
  const searchClient = createWebClient(primarySearchClient, fallbackClient);
  const { addMemoryFact, removeMemoryFact } = memory;
  // Выполняет вызов инструмента и возвращает строку для модели.
  /**
   * Execute a tool; failures become textual results for the model.
   * @param call Requested function and arguments.
   * @param context Memory scope and attribution.
   * @returns Tool output or a readable failure description.
   */
  async function runTool(
    call: import("../types.ts").ToolCall,
    context: import("../types.ts").RequestContext,
  ) {
    const { name } = call.function;
    const args = call.function.arguments ?? {};

    console.log(`[tool] ${name}`, JSON.stringify(args));

    try {
      if (["search_images", "send_image", "search_gifs", "send_gif"].includes(name)) {
        if (!context?.sendImage || !context.imageState) return "Отправка картинок недоступна.";
        const isGif = name === "search_gifs" || name === "send_gif";
        if (isGif && !gifSearch) return "Поиск GIF не настроен.";
        if (name === "search_images" || name === "search_gifs") {
          const query = String(args.query ?? "").trim();
          if (!query) return "Нужен поисковый запрос.";
          const results = await (isGif ? gifSearch : imageSearch)(query);
          return JSON.stringify(
            results.slice(0, 5).map((image) => {
              const id = `${isGif ? "gif" : "image"}_${context.imageState.candidates.size + 1}`;
              context.imageState.candidates.set(id, image);
              return { id, ...image };
            }),
          );
        }
        if (context.imageState.sent) return "Картинка в этом ответе уже отправлена.";
        if (context.imageState.attempted)
          return "Попытка отправки уже была; не повторяй её, чтобы избежать дубликатов.";
        const image = context.imageState.candidates.get(String(args.id));
        if (!image || (image.kind === "gif") !== isGif)
          return "Неизвестный id: сначала выполни подходящий поиск search_images или search_gifs.";
        // Mark before sending: an ambiguous delivery error must not cause duplicates.
        context.imageState.attempted = true;
        await context.sendImage(image);
        context.imageState.sent = true;
        return "Медиа отправлено. Если оно само отвечает на запрос, заверши ответ без текста. Не добавляй подпись, ссылку, подтверждение отправки или эмодзи. Если пояснение действительно нужно, ответь коротко. Не утверждай, что видел изображение: поиск дал только метаданные.";
      }
      if (name === "read_history") {
        if (typeof context?.readHistory !== "function")
          return "Чтение истории недоступно в этом чате.";
        const limit = Math.min(20, Math.max(1, Math.floor(Number(args.limit) || 10)));
        const history = await context.readHistory(limit);
        return JSON.stringify({
          ...history,
          messages: history.messages.slice(-limit).map((entry) => ({
            ...entry,
            content: truncate(entry.content, 800),
          })),
        });
      }
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
            const page = pages[index]?.status === "fulfilled" ? pages[index].value : null;
            return {
              title: result.title,
              url: result.url,
              content: page ? truncate(page.content, 3500) : truncate(result.content, 1500),
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
    definitions: ({ scopeId, history, images }) => [
      ...(images ? IMAGE_TOOLS : []),
      ...(images && gifSearch ? GIF_TOOLS : []),
      ...(history ? [HISTORY_TOOL] : []),
      ...(scopeId ? MEMORY_TOOLS : []),
      ...(searchClient ? TOOLS : []),
    ],
  };
}
