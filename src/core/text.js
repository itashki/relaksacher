/** @file Implementation of core/text. */
/**
 * Truncate a value using UTF-16 length, adding an ellipsis when needed.
 * @param {*} value Value to stringify; nullish values become an empty string.
 * @param {number} maxLength Maximum prefix length before the ellipsis.
 * @returns {string} Display text.
 */
export function truncate(value, maxLength) {
  const textValue = String(value ?? "");
  return textValue.length > maxLength
    ? `${textValue.slice(0, maxLength)}…`
    : textValue;
}

/**
 * Extract the standalone /think command without matching URL paths.
 * @param {string} content Incoming message text.
 * @returns {{flags: {think: boolean}, content: string}} Flags and cleaned text.
 */
export function parseCommands(content) {
  const flags = { think: false };
  let found = false;

  let cleaned = content.replace(
    /(^|\s)\/(think)(?=\s|$)/giu,
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

