import {
  ActionRowBuilder,
  AttachmentBuilder,
  ButtonBuilder,
  ButtonStyle,
  Client,
  Events,
  GatewayIntentBits,
  MessageFlags,
  MessageType,
  PermissionFlagsBits,
} from "discord.js";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Ollama } from "ollama";
import "dotenv/config";

function loadConfig() {
  const token = process.env.BOT_TOKEN;
  const applicantId = process.env.APPLICANT_ID;
  const publicKey = process.env.PUBLIC_KEY;
  const OLLAMA_URL = process.env.OLLAMA_URL;
  const OLLAMA_MODEL = process.env.OLLAMA_MODEL;
  const OLLAMA_TIMEOUT = parseInt(process.env.OLLAMA_TIMEOUT, 10);
  // Необязателен: без ключа веб-поиск просто отключён.
  const OLLAMA_API_KEY = process.env.OLLAMA_API_KEY || null;
  // Размер контекстного окна. По умолчанию Ollama часто даёт всего 2-4k токенов,
  // и результаты поиска просто обрезаются.
  const OLLAMA_NUM_CTX = parseInt(process.env.OLLAMA_NUM_CTX, 10) || 16384;
  if (!token) {
    throw new Error("BOT_TOKEN is not defined in the environment variables.");
  }
  if (!applicantId) {
    throw new Error(
      "APPLICANT_ID is not defined in the environment variables.",
    );
  }
  if (!publicKey) {
    throw new Error("PUBLIC_KEY is not defined in the environment variables.");
  }
  if (!OLLAMA_URL) {
    throw new Error("OLLAMA_URL is not defined in the environment variables.");
  }
  if (!OLLAMA_MODEL) {
    throw new Error(
      "OLLAMA_MODEL is not defined in the environment variables.",
    );
  }
  if (isNaN(OLLAMA_TIMEOUT)) {
    throw new Error("OLLAMA_TIMEOUT is not a valid number.");
  }
  return {
    token,
    applicantId,
    publicKey,
    OLLAMA_URL,
    OLLAMA_MODEL,
    OLLAMA_TIMEOUT,
    OLLAMA_API_KEY,
    OLLAMA_NUM_CTX,
  };
}

function splitMessage(content, maxLength = 2000) {
  const remaining = Array.from(content);
  const chunks = [];

  while (remaining.length > maxLength) {
    let splitAt = maxLength;
    for (
      let index = maxLength - 1;
      index >= Math.floor(maxLength / 2);
      index--
    ) {
      if (/\s/u.test(remaining[index])) {
        splitAt = index + 1;
        break;
      }
    }

    chunks.push(remaining.splice(0, splitAt).join(""));
  }

  if (remaining.length > 0 || chunks.length === 0) {
    chunks.push(remaining.join(""));
  }

  return chunks;
}

const config = loadConfig();

// Клиент Ollama с нужным хостом (в исходном коде `url` в chat() игнорировался).
const ollama = new Ollama({ host: config.OLLAMA_URL });

// ---------------------------------------------------------------------------
// Долговременная память. У каждого сервера свой файл memory/<guildId>.json,
// поэтому факты одного сервера физически не попадают в запросы другого.
// Чтобы стереть память сервера, достаточно удалить его файл (или записи в нём).
// ---------------------------------------------------------------------------
// Путь считается от папки с bot.js, а не от текущей папки процесса, поэтому
// файлы не «убегают» в другое место при запуске через pm2, systemd, Docker и т.п.
// Абсолютный MEMORY_DIR из .env тоже работает.
const MEMORY_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  process.env.MEMORY_DIR || "memory",
);
const MAX_MEMORY_FACTS = 50; // при переполнении самые старые записи удаляются
const MAX_FACT_LENGTH = 300;

function memoryPath(guildId) {
  if (!/^\d+$/.test(guildId)) throw new Error("Некорректный id сервера");
  return path.join(MEMORY_DIR, `${guildId}.json`);
}

async function loadMemory(guildId) {
  try {
    const data = JSON.parse(await readFile(memoryPath(guildId), "utf8"));
    return Array.isArray(data) ? data : [];
  } catch (error) {
    if (error.code !== "ENOENT") {
      console.error("Failed to load memory:", error);
    }
    return [];
  }
}

async function saveMemory(guildId, facts) {
  await mkdir(MEMORY_DIR, { recursive: true });
  const file = memoryPath(guildId);
  const tmp = `${file}.tmp`;
  await writeFile(tmp, JSON.stringify(facts, null, 2), "utf8");
  await rename(tmp, file); // атомарная запись, чтобы файл не побился при сбое
}

// Очередь на каждый сервер, чтобы параллельные запросы не затирали друг друга.
const memoryLocks = new Map();
function withMemoryLock(guildId, task) {
  const previous = memoryLocks.get(guildId) ?? Promise.resolve();
  const next = previous.catch(() => {}).then(task);
  memoryLocks.set(guildId, next);
  next
    .finally(() => {
      if (memoryLocks.get(guildId) === next) memoryLocks.delete(guildId);
    })
    .catch(() => {});
  return next;
}

function addMemoryFact(guildId, rawFact, authorName) {
  const fact = String(rawFact ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_FACT_LENGTH);
  if (!fact) return Promise.resolve("Пустую запись сохранить нельзя.");

  return withMemoryLock(guildId, async () => {
    const facts = await loadMemory(guildId);
    const duplicate = facts.find(
      (entry) => entry.fact.toLowerCase() === fact.toLowerCase(),
    );
    if (duplicate) return `Такая запись уже есть (id ${duplicate.id}).`;

    const id = facts.reduce((max, entry) => Math.max(max, entry.id), 0) + 1;
    // by и at нужны только тебе, чтобы разбираться, кто и когда что добавил.
    facts.push({ id, fact, by: authorName, at: new Date().toISOString() });
    while (facts.length > MAX_MEMORY_FACTS) facts.shift();

    await saveMemory(guildId, facts);
    return `Запомнено (id ${id}).`;
  });
}

function removeMemoryFact(guildId, rawId) {
  const id = Number(rawId);
  return withMemoryLock(guildId, async () => {
    const facts = await loadMemory(guildId);
    const remaining = facts.filter((entry) => entry.id !== id);
    if (remaining.length === facts.length) {
      return `Записи с id ${rawId} нет.`;
    }
    await saveMemory(guildId, remaining);
    return `Запись ${id} удалена.`;
  });
}

// Блок системного промпта с памятью сервера.
function buildMemoryPrompt(facts, enabled) {
  if (!enabled) return "";
  const list = facts.length
    ? facts.map((entry) => `[${entry.id}] ${entry.fact}`).join("\n")
    : "(пока пусто)";
  return `
            У тебя есть долговременная память этого сервера, общая для всех его участников. Сохранённые записи:
            ${list}
            Учитывай записи в ответах там, где это уместно: это факты и договорённости сервера, следуй им, если они не противоречат этим правилам. 
            Вызывай remember, когда участник просит что-то запомнить или сообщает устойчивый факт, правило или шутку сервера, которые пригодятся позже; формулируй запись коротко и самодостаточно. 
            Вызывай forget, если запись устарела или участник просит её убрать. 
            Не запоминай пароли, токены, адреса, телефоны, другие личные данные и мелочи разговора.`;
}

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

// Веб-поиск и загрузка страниц — это облачное API Ollama (ollama.com),
// поэтому для него отдельный клиент с API-ключом.
const searchClient = config.OLLAMA_API_KEY
  ? new Ollama({
      host: "https://ollama.com",
      headers: { Authorization: `Bearer ${config.OLLAMA_API_KEY}` },
    })
  : null;

// Максимум раундов «модель -> инструмент -> модель» за один запрос.
const MAX_TOOL_ROUNDS = 5;

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

// Серый блок с рассуждениями модели: ANSI-код 30 в ```ansi блоке Discord
// рисует серым. Показываем только хвост, чтобы влезть в лимит сообщения.
function thinkingBlock(raw, room) {
  const clean = raw
    .replace(/\u001b/g, "")
    .replace(/```/g, "'''")
    .trim();
  const maxTail = room - 60; // запас на заголовок и обрамление блока
  if (!clean || maxTail < 100) return "";
  const tail = clean.length > maxTail ? `…${clean.slice(-maxTail)}` : clean;
  return `-# 💭 Размышления\n\`\`\`ansi\n\u001b[30m${tail}\u001b[0m\n\`\`\``;
}

function truncate(value, maxLength) {
  const textValue = String(value ?? "");
  return textValue.length > maxLength
    ? `${textValue.slice(0, maxLength)}…`
    : textValue;
}

// Короткий статус для отображения в Discord, пока выполняется инструмент.
function describeToolCall(call) {
  const args = call.function.arguments ?? {};
  if (call.function.name === "web_search") {
    return `🔍 Ищу в интернете: ${truncate(args.query, 100)}`;
  }
  if (call.function.name === "web_fetch") {
    return `🌐 Открываю страницу: <${truncate(args.url, 150)}>`;
  }
  if (call.function.name === "remember") {
    return `🧠 Запоминаю: ${truncate(args.fact, 100)}`;
  }
  if (call.function.name === "forget") {
    return `🧠 Забываю запись #${truncate(args.id, 10)}`;
  }
  return `⚙️ Использую инструмент ${call.function.name}`;
}

// Выполняет вызов инструмента и возвращает строку для модели.
async function runTool(call, context) {
  const { name } = call.function;
  const args = call.function.arguments ?? {};

  console.log(`[tool] ${name}`, JSON.stringify(args));

  try {
    if (name === "remember" || name === "forget") {
      // Память работает только на серверах и только в рамках текущего сервера.
      if (!context?.guildId) return "Память доступна только на сервере.";
      const result =
        name === "remember"
          ? await addMemoryFact(context.guildId, args.fact, context.authorName)
          : await removeMemoryFact(context.guildId, args.id);
      console.log(`[tool] ${name} -> ${result} (${MEMORY_DIR})`);
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

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

// Команды в тексте сообщения: /think и /search (их можно писать вместе).
// Распознаются только как отдельные слова, поэтому ссылки вроде
// https://site.com/search не срабатывают. Возвращает флаги и текст без команд.
function parseCommands(content) {
  const flags = { think: false, search: false };
  let found = false;

  let cleaned = content.replace(
    /(^|\s)\/(think|search)(?=\s|$)/giu,
    (_match, prefix, command) => {
      flags[command.toLowerCase()] = true;
      found = true;
      return prefix;
    },
  );

  if (found) {
    cleaned = cleaned.replace(/[ \t]{2,}/g, " ").trim();
  }

  return { flags, content: cleaned };
}

// Название треда: начало вопроса без упоминаний и команд (лимит Discord — 100).
function threadName(message) {
  const topic = parseCommands(message.content)
    .content.replace(/<[@#][!&]?\d+>/g, "")
    .replace(/\s+/g, " ")
    .trim();
  const author = message.member?.displayName ?? message.author.username;
  return truncate(topic || `Диалог с ${author}`, 90);
}

// Контекст для треда, который создал бот: исходное сообщение, из которого вырос
// тред, и последние сообщения в самом треде (у них нет цепочки reply).
async function buildThreadConversation(message) {
  const thread = message.channel;
  const [starter, history] = await Promise.all([
    thread.fetchStarterMessage().catch(() => null),
    thread.messages.fetch({ limit: 30, before: message.id }).catch(() => null),
  ]);
  const past = history ? [...history.values()].reverse() : [];

  return [...(starter ? [starter] : []), ...past, message].filter(
    (entry) =>
      entry === message ||
      ((entry.type === MessageType.Default ||
        entry.type === MessageType.Reply) &&
        entry.content.trim() &&
        (!entry.author.bot || entry.author.id === client.user.id)),
  );
}

// Описание автора сообщения для модели: отображаемое имя, username и id.
function describeAuthor(entry) {
  const displayName =
    entry.member?.displayName ??
    entry.author.globalName ??
    entry.author.username;
  return `${displayName} (username: ${entry.author.username}, id: ${entry.author.id})`;
}

// Минимальный интервал между правками сообщения (лимиты Discord на edit).
const EDIT_INTERVAL_MS = 1200;
const STOP_PREFIX = "stop_generation:";

// id запроса -> состояние активной генерации
const activeGenerations = new Map();

function buildStopRow(generationId) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`${STOP_PREFIX}${generationId}`)
      .setLabel("Остановить генерацию")
      .setEmoji("⏹️")
      .setStyle(ButtonStyle.Secondary),
  );
}

client.once(Events.ClientReady, () => {
  client.user.setPresence({ status: "online" });
  console.log(`Logged in as ${client.user.tag}`);
  console.log("Ollama model:", config.OLLAMA_MODEL);
  console.log("Ollama URL:", config.OLLAMA_URL);
  console.log("Memory dir:", MEMORY_DIR);
});

function shutdown(signal) {
  console.log(`Received ${signal}, shutting down.`);
  for (const generation of activeGenerations.values()) {
    generation.stop();
  }
  client.destroy();
  process.exitCode = 0;
}

process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);

// Обработка нажатия кнопки «Остановить генерацию»
client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isButton()) return;
  if (!interaction.customId.startsWith(STOP_PREFIX)) return;

  const generationId = interaction.customId.slice(STOP_PREFIX.length);
  const generation = activeGenerations.get(generationId);

  if (!generation) {
    // Генерация уже закончилась — просто убираем кнопку.
    await interaction.update({ components: [] }).catch(() => {});
    return;
  }

  // Останавливать могут автор запроса и модераторы (право «Управлять
  // сообщениями»). Администраторы проходят эту проверку автоматически.
  const isAuthor = interaction.user.id === generation.authorId;
  const isModerator =
    interaction.memberPermissions?.has(PermissionFlagsBits.ManageMessages) ??
    false;

  if (!isAuthor && !isModerator) {
    await interaction
      .reply({
        content:
          "Остановить генерацию может только автор запроса или модератор.",
        flags: MessageFlags.Ephemeral,
      })
      .catch(() => {});
    return;
  }

  generation.stop();
  await interaction.deferUpdate().catch(() => {});
});

client.on(Events.MessageCreate, async (message) => {
  if (message.author.bot) return;

  if (!client.user) return;

  const isMentioned = message.mentions.has(client.user);
  let referencedMessage = message.reference
    ? await message.fetchReference().catch(() => null)
    : null;
  const isReplyToBot = referencedMessage?.author.id === client.user.id;

  // В треде, который создал сам бот, отвечаем на все сообщения без упоминания.
  const inBotThread =
    message.channel.isThread() && message.channel.ownerId === client.user.id;

  if (!isMentioned && !isReplyToBot && !inBotThread) return;

  let conversation = [message];
  while (referencedMessage) {
    conversation.push(referencedMessage);
    referencedMessage = referencedMessage.reference
      ? await referencedMessage.fetchReference().catch(() => null)
      : null;
  }
  conversation.reverse();

  if (inBotThread) conversation = await buildThreadConversation(message);

  // Команды берём только из текущего сообщения, а не из всей цепочки.
  const { flags } = parseCommands(message.content);
  const useSearch = flags.search && Boolean(searchClient);

  // Вместо ответа в канале создаём тред под сообщением пользователя и пишем в
  // него. В уже существующем треде тред не создаётся (вложенные запрещены):
  // там бот отвечает как раньше. Если создать тред не вышло (нет прав и т.п.),
  // тоже отвечаем обычным реплаем.
  let newThread = null;
  if (message.guild && !message.channel.isThread()) {
    newThread = await message
      .startThread({ name: threadName(message), autoArchiveDuration: 60 })
      .catch((error) => {
        console.error("Failed to create thread:", error);
        return null;
      });
  }

  const generationId = message.id;
  const stopRow = buildStopRow(generationId);

  const generation = {
    authorId: message.author.id,
    stream: null,
    stopped: false,
    timedOut: false,
    stop() {
      this.stopped = true;
      this.stream?.abort();
    },
  };
  activeGenerations.set(generationId, generation);

  let text =
    flags.search && !searchClient
      ? "⚠️ Поиск недоступен: не задан OLLAMA_API_KEY.\n\n"
      : "";
  let status = ""; // временная строка вроде «Ищу в интернете…», не часть ответа
  let thinkingLog = ""; // все рассуждения модели за запрос (режим /think)
  let liveThinking = ""; // рассуждения текущего раунда, пока стримятся в сообщение
  let attachedLog = ""; // что уже лежит в прикреплённом thinking.txt
  let attachNow = false; // прикрепить файл при ближайшей правке (начался ответ)
  const replies = []; // отправленные сообщения бота
  const sent = []; // что сейчас показано в каждом сообщении

  // Приводит отправленные сообщения в соответствие с накопленным текстом.
  async function flush(final) {
    let displayed = text;
    if (status) {
      displayed = `${text ? `${text}\n\n` : ""}*${status}*`;
    }
    // Пока модель думает, её рассуждения стримятся в сообщение серым блоком.
    if (liveThinking.trim()) {
      const room = 1850 - displayed.length - (displayed ? 2 : 0);
      const block = thinkingBlock(liveThinking, room);
      if (block) displayed = displayed ? `${displayed}\n\n${block}` : block;
    }
    const chunks = splitMessage(displayed);
    for (let i = 0; i < chunks.length; i++) {
      const isLast = i === chunks.length - 1;
      const content = chunks[i].trim() ? chunks[i] : "…";
      const withButton = isLast && !final;

      const payload = {
        content,
        components: withButton ? [stopRow] : [],
        allowedMentions: { parse: [], repliedUser: false },
      };

      // Когда начался ответ (или в конце), рассуждения уходят в файл на первом
      // сообщении. Если рассуждения изменились, файл заменяется новым.
      const logSnapshot = thinkingLog.trim();
      const attachThinking =
        i === 0 &&
        logSnapshot.length > 0 &&
        logSnapshot !== attachedLog &&
        (final || attachNow);
      if (attachThinking) {
        payload.files = [
          new AttachmentBuilder(Buffer.from(logSnapshot, "utf8"), {
            name: "thinking.txt",
          }),
        ];
        // При правке без attachments прежний файл заменяется новым.
        if (replies[i]) payload.attachments = [];
      }

      if (!replies[i]) {
        if (i === 0 && newThread) {
          // Первый кусок ответа идёт прямо в созданный тред.
          replies[i] = await newThread.send(payload);
        } else {
          const parent = i === 0 ? message : replies[i - 1];
          replies[i] = await parent.reply(payload);
        }
        sent[i] = { content, withButton };
      } else if (
        attachThinking ||
        sent[i].content !== content ||
        sent[i].withButton !== withButton
      ) {
        await replies[i].edit(payload);
        sent[i] = { content, withButton };
        if (attachThinking) {
          attachedLog = logSnapshot;
          attachNow = false;
        }
      }
    }
  }

  // Таймаут на всю генерацию
  const timeoutTimer = setTimeout(() => {
    generation.timedOut = true;
    generation.stop();
  }, config.OLLAMA_TIMEOUT);

  let failed = false;

  try {
    // Сразу показываем плейсхолдер с кнопкой остановки.
    await flush(false);

    // Читаем память именно этого сервера (у других серверов свои файлы).
    const memoryFacts = message.guildId
      ? await loadMemory(message.guildId)
      : [];
    const memoryPrompt = buildMemoryPrompt(
      memoryFacts,
      Boolean(message.guildId),
    );

    const messages = [
      {
        role: "system",
        content: `Тебя зовут Релаксачер. Ты находишься на сервере Discord и общаешься с его участниками в текстовых каналах. Упоминание пользователя в формате <@${client.user.id}> или <@!${client.user.id}> означает, 
            что сообщение адресовано тебе. Упоминание роли в формате <@&ID> само по себе не является упоминанием тебя. 
            Отвечай сразу по сути запроса, учитывая контекст диалога. 
            Не представляйся без необходимости и не начинай ответ с приветствия, если его не требует контекст. Если тебя спросят, как тебя зовут, отвечай, что ты Релаксачер. Всегда старайся отвечать на русском языке, даже если вопрос или найденные источники на другом языке; отвечай на другом языке только если пользователь прямо об этом попросил (например, просит ответить по-английски или перевести текст).
            Старайся давать короткие ответы, не превышающие 2000 символов если тебя не просят развернуто ответить.
            Каждое сообщение пользователя начинается со строки вида «[Автор: имя (username: ..., id: ...)]» — 
            так ты видишь, кто именно пишет. В диалоге могут участвовать несколько людей, различай их по этой строке. 
            Можешь обращаться к пользователю по имени, когда это уместно, или упомянуть его как <@id>. 
            Никогда не пиши эту строку «[Автор: ...]» в своих ответах.
            Сегодня ${new Date().toISOString().slice(0, 10)}.${memoryPrompt}
            ${
              useSearch
                ? `У тебя есть инструменты web_search (поиск в интернете) и web_fetch (загрузка страницы по URL). 
            Используй их, когда нужна актуальная информация, новости, свежие данные или факты, в которых ты не уверен; 
            на простые вопросы и в обычной беседе отвечай без поиска. 
            Порядок работы с поиском: 
            1) сделай web_search; 
            2) в результатах уже есть текст страниц — внимательно прочитай его; если ответа там нет или нужны детали, открой 1-2 самые подходящие страницы через web_fetch; 
            3) отвечай только на основе прочитанного: перескажи суть и конкретные факты своими словами, сопоставь источники, отметь противоречия. 
            Не отвечай одним списком ссылок и не выдумывай то, чего нет в источниках; если информации не хватило, так и скажи. 
            В конце укажи 1-3 самых полезных источника, оборачивая ссылки в <>, чтобы Discord не разворачивал превью.`
                : ""
            }`,
      },
      ...conversation.map((entry) =>
        entry.author.id === client.user.id
          ? { role: "assistant", content: entry.content }
          : {
              role: "user",
              content: `[Автор: ${describeAuthor(entry)}]\n${parseCommands(entry.content).content}`,
            },
      ),
    ];

    // Инструменты памяти доступны на серверах всегда, поиск — только по /search.
    const allTools = [
      ...(message.guildId ? MEMORY_TOOLS : []),
      ...(useSearch ? TOOLS : []),
    ];
    const tools = allTools.length ? allTools : undefined;
    let lastEdit = 0;
    let forceFlush = false; // сразу обновить сообщение, не дожидаясь интервала

    for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
      if (generation.stopped) break;

      const stream = await ollama.chat({
        model: config.OLLAMA_MODEL,
        think: flags.think,
        stream: true,
        options: { num_ctx: config.OLLAMA_NUM_CTX },
        // В последнем раунде инструменты отключаем, чтобы модель точно ответила.
        tools: round < MAX_TOOL_ROUNDS ? tools : undefined,
        messages,
      });

      generation.stream = stream;
      // Кнопку могли нажать, пока ждали начала ответа.
      if (generation.stopped) {
        stream.abort();
        break;
      }

      let roundContent = "";
      let roundThinking = "";
      liveThinking = "";
      let roundHasThinking = false;
      let separated = false;
      const toolCalls = [];

      for await (const part of stream) {
        if (generation.stopped) break;

        const thinkingDelta = part.message?.thinking ?? "";
        if (thinkingDelta) {
          roundThinking += thinkingDelta;
          // Раунды (например, до и после поиска) разделяем чертой.
          if (!roundHasThinking && thinkingLog) {
            thinkingLog += "\n\n---\n\n";
          }
          roundHasThinking = true;
          thinkingLog += thinkingDelta;
          liveThinking += thinkingDelta;
        }

        const delta = part.message?.content ?? "";
        if (delta) {
          // Ответ начался: убираем рассуждения из сообщения и кладём в файл.
          if (liveThinking) {
            liveThinking = "";
            attachNow = true;
            forceFlush = true;
          }
          // Отделяем текст после поиска от текста до него.
          if (!separated && round > 0 && text) text += "\n\n";
          separated = true;
          text += delta;
          roundContent += delta;
        }

        if (part.message?.tool_calls?.length) {
          toolCalls.push(...part.message.tool_calls);
        }

        if (forceFlush || Date.now() - lastEdit >= EDIT_INTERVAL_MS) {
          forceFlush = false;
          lastEdit = Date.now();
          await flush(false);
        }
      }

      liveThinking = ""; // рассуждения раунда закончились

      // Модель закончила ответ (или остановили) — выходим из цикла.
      if (generation.stopped || toolCalls.length === 0) break;

      messages.push({
        role: "assistant",
        content: roundContent,
        // При tool calling Ollama рекомендует возвращать рассуждения модели обратно.
        thinking: roundThinking || undefined,
        tool_calls: toolCalls,
      });

      for (const call of toolCalls) {
        if (generation.stopped) break;

        status = describeToolCall(call);
        await flush(false);
        lastEdit = Date.now();

        const result = await runTool(call, {
          guildId: message.guildId,
          authorName: message.member?.displayName ?? message.author.username,
        });
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
    if (!generation.stopped) {
      failed = true;
      console.error("Failed to get response from Ollama:", error);
    }
  } finally {
    clearTimeout(timeoutTimer);
    status = "";
    liveThinking = "";
    generation.stream?.abort();
    activeGenerations.delete(generationId);
  }

  if (failed) {
    text += text
      ? "\n\n⚠️ Ошибка при генерации ответа."
      : "Произошла ошибка при обработке запроса.";
  } else if (generation.timedOut) {
    text += text
      ? "\n\n⚠️ Превышено время ожидания."
      : "Превышено время ожидания ответа.";
  } else if (generation.stopped && !text.trim()) {
    text = "Генерация остановлена.";
  }

  try {
    await flush(true); // финальное состояние, кнопка убирается
  } catch (error) {
    console.error("Failed to reply to message:", error);
  }
});

client.login(config.token).catch((err) => {
  console.error("Failed to login:", err);
  process.exit(1);
});
