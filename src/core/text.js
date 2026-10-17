export function truncate(value, maxLength) {
  const textValue = String(value ?? "");
  return textValue.length > maxLength
    ? `${textValue.slice(0, maxLength)}…`
    : textValue;
}

export function parseCommands(content) {
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

