import { attachImages, downloadImage } from "./images.js";
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  Client,
  Events,
  GatewayIntentBits,
  MessageFlags,
  PermissionFlagsBits,
} from "discord.js";
import { parseCommands, truncate } from "../core/text.js";

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
// Короткий статус для отображения в Discord, пока выполняется инструмент.
function describeToolCall(call) {
  const args = call.function.arguments ?? {};
  if (call.function.name === "enable_thinking") {
    return "💭 Обдумываю запрос";
  }
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


function imageFiles(message) {
  return [...(message.attachments?.values() ?? [])]
    .filter((file) => /^image\/(jpeg|png|webp)$/.test(file.contentType ?? "") || /\.(png|jpe?g|webp)$/i.test(file.name ?? ""))
    .map((file) => file.url);
}

export function createDiscordBot({ config, assistant, memoryDirectory,
  loadImage = (url) => downloadImage(url, { allowedHosts: ["cdn.discordapp.com", "media.discordapp.net"] }),
}) {
  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
    ],
  });

  // Название треда: начало вопроса без упоминаний и команд (лимит Discord — 100).
  function threadName(message) {
    const topic = parseCommands(message.content)
      .content.replace(/<[@#][!&]?\d+>/g, "")
      .replace(/\s+/g, " ")
      .trim();
    const author = message.member?.displayName ?? message.author.username;
    return truncate(topic || `Диалог с ${author}`, 90);
  }

  // Описание автора сообщения для модели: отображаемое имя, username и id.
  function describeAuthor(entry) {
    const displayName =
      entry.member?.displayName ??
      entry.author.globalName ??
      entry.author.username;
    return `${displayName} (username: ${entry.author.username}, id: ${entry.author.id})`;
  }

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
    console.log("Ollama models:", config.OLLAMA_MODELS);
    console.log("Ollama URL:", config.OLLAMA_URL);
    console.log("Memory dir:", memoryDirectory);
  });

  function shutdown(signal) {
    console.log(`Received ${signal}, shutting down.`);
    for (const generation of activeGenerations.values()) {
      generation.stop();
    }
    client.destroy();

  }


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
    const seen = new Set([message.id]);
    while (referencedMessage && !seen.has(referencedMessage.id) && conversation.length < 30) {
      seen.add(referencedMessage.id);
      conversation.push(referencedMessage);
      referencedMessage = referencedMessage.reference
        ? await referencedMessage.fetchReference().catch(() => null)
        : null;
    }
    conversation.reverse();

    // Команды берём только из текущего сообщения, а не из всей цепочки.
    const { flags } = parseCommands(message.content);

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

    let snapshot;
    const replies = []; // отправленные сообщения бота
    const sent = []; // что сейчас показано в каждом сообщении

    // Приводит отправленные сообщения в соответствие с накопленным текстом.
    async function flush(state) {
      snapshot = state;
      const { text, final } = state;
      const status = state.status ? describeToolCall(state.status) : "";
      let displayed = text;
      if (status) {
        displayed = `${text ? `${text}\n\n` : ""}*${status}*`;
      }
      if (state.modelAlias) {
        displayed = displayed ? `${displayed}\n\n-# ${state.modelAlias}` : `…\n\n-# ${state.modelAlias}`;
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
          sent[i].content !== content ||
          sent[i].withButton !== withButton
        ) {
          await replies[i].edit(payload);
          sent[i] = { content, withButton };
        }
      }
    }

    const modelConversation = conversation.map((entry) => entry.author.id === client.user.id
        ? { role: "assistant", content: entry.content }
        : { role: "user", content: `[Автор: ${describeAuthor(entry)}]\n${parseCommands(entry.content).content}` });
    await attachImages(modelConversation, conversation.map(imageFiles), loadImage);
    const session = assistant.createSession({
      assistantName: "Релаксачер",
      background: [],
      conversation: modelConversation,
      context: { scopeId: message.guildId, authorName: message.member?.displayName ?? message.author.username },
      think: flags.think,
      search: flags.search || undefined,
      platformInstructions: `Платформа: Discord.
Твои пинги: <@${client.user.id}> и <@!${client.user.id}>. Пинги других id и ролей <@&ID> не обозначают тебя.
Для адресного упоминания участника используй <@id> только с известным id. Допустим Discord Markdown; ссылки на источники пиши как <https://example.org>, без превью. Не используй HTML.`,
      onQueued: (position) => flush({
        text: `⏳ ${message.member?.displayName ?? message.author.username}, ваш запрос в очереди. Позиция: ${position}.`,
        status: "", thinkingLog: "", liveThinking: "", final: false,
      }),
      onUpdate: flush,
    });
    activeGenerations.set(generationId, { authorId: message.author.id, stop: session.stop });
    try {
      await session.run();
    } catch (error) {
      console.error("Failed to reply to message:", error);
      if (snapshot) await flush({ ...snapshot, status: "", liveThinking: "", final: true }).catch(() => {});
    } finally {
      activeGenerations.delete(generationId);
    }
  });

  return { client, start: () => client.login(config.token), stop: () => shutdown("stop") };
}
