/** @file Recognize English/Russian music commands and normalize only command words and mode values. */
const commands: Record<string, string> = {
  панель: "panel",
  помощь: "help",
  хелп: "help",
  добавить: "add",
  добавь: "add",
  поиск: "search",
  найти: "search",
  список: "list",
  играть: "play",
  включить: "play",
  пауза: "pause",
  продолжить: "resume",
  дальше: "skip",
  пропустить: "skip",
  стоп: "stop",
  остановить: "stop",
  выйти: "leave",
  повтор: "repeat",
  случайно: "shuffle",
  перемешивание: "shuffle",
  перемешать: "mix",
  очередь: "queue",
  перейти: "jump",
  удалить: "remove",
  плейлист: "playlist",
  плейлисты: "playlists",
};
const operations: Record<string, string> = {
  создать: "create",
  выбрать: "use",
  активировать: "use",
  использовать: "use",
  управление: "manage",
  управлять: "manage",
  переименовать: "rename",
  удалить: "delete",
  добавить: "add",
  поиск: "search",
  найти: "search",
  экспорт: "export",
  импорт: "import",
};

/** Detect the command prefix at a word boundary, including commands whose arguments need validation. */
export function isMusicCommand(content: string): boolean {
  return /^\s*!(?:music|музыка)(?:\s|$)/iu.test(content);
}

/** Parse freely mixed aliases while preserving case, names, search text and URLs in arguments. */
export function parseMusicCommand(content: string): { command: string; argument: string } | null {
  const match = content.trim().match(/^!(?:music|музыка)(?:\s+(\S+))?(?:\s+([\s\S]*))?$/iu);
  if (!match) return null;
  const word = (match[1] ?? "panel").toLowerCase();
  const command = commands[word] ?? word;
  let argument = match[2]?.trim() ?? "";
  if (command === "playlist" && argument) {
    const [, operation, rest = ""] = argument.match(/^(\S+)([\s\S]*)$/)!;
    const normalized = operations[operation.toLowerCase()] ?? operation.toLowerCase();
    argument = normalized + rest;
  } else if (command === "repeat") {
    const modes: Record<string, string> = { выкл: "off", трек: "track", все: "all", всё: "all" };
    argument = modes[argument.toLowerCase()] ?? argument;
  } else if (command === "shuffle") {
    const modes: Record<string, string> = { вкл: "on", выкл: "off" };
    argument = modes[argument.toLowerCase()] ?? argument;
  }
  return { command, argument };
}
