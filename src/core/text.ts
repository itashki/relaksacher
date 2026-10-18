/**
 * Truncate a value using UTF-16 length, adding an ellipsis when needed.
 * @param value Value to stringify; nullish values become an empty string.
 * @param maxLength Maximum prefix length before the ellipsis.
 * @returns Display text.
 */
export function truncate(value: any, maxLength: number) {
  const textValue = String(value ?? "");
  return textValue.length > maxLength
    ? `${textValue.slice(0, maxLength)}…`
    : textValue;
}

/**
 * Extract the standalone /think command without matching URL paths.
 * @param content Incoming message text.
 * @returns Flags and cleaned text.
 */
export function parseCommands(content: string) {
  const flags = { think: false };
  let found = false;

  let cleaned = content.replace(
    /(^|\s)\/(think)(?=\s|$)/giu,
    (_match, prefix, command) => {
      flags.think = true;
      found = true;
      return prefix;
    },
  );

  if (found) {
    cleaned = cleaned.replace(/[ \t]{2,}/g, " ").trim();
  }

  return { flags, content: cleaned };
}

