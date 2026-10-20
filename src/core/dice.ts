/** @file Bounded dice expressions and platform-independent roll command replies. */
import { randomInt } from "node:crypto";

const usage = "Используйте !roll 2d6+5 или !r d20+3 adv (преимущество) / dis (помеха).";
const commandPattern = /^!(?:roll|r)(?:@(\w+))?(?:\s+([\s\S]*))?$/iu;

/** Recognize a complete roll command; optional username is validated by the transport. */
export function parseRollCommand(text: string) {
  const match = text.trim().match(commandPattern);
  return match ? { username: match[1], argument: match[2] ?? "" } : null;
}

/**
 * Evaluate addition/subtraction of dice and integers, showing every random draw.
 * Advantage/disadvantage draws each die twice and keeps its maximum/minimum.
 * Limits: 200 input characters, 20 terms, 100 dice, d2–d1000000, modifiers up to 1000000.
 * Invalid input returns usage text without drawing any dice. Inject draw for deterministic tests.
 */
export function rollDice(
  argument: string,
  draw = (sides: number) => randomInt(1, sides + 1),
): string {
  try {
    if (argument.length > 200) throw new Error("Слишком длинное выражение.");
    let expression = argument.trim().toLowerCase();
    const modeMatch = expression.match(/\s+(adv|dis|преимущество|помеха)$/u);
    const mode = modeMatch
      ? ["adv", "преимущество"].includes(modeMatch[1])
        ? "adv"
        : "dis"
      : null;
    if (modeMatch) expression = expression.slice(0, modeMatch.index).trim();
    // Remove whitespace only after tokenization, so `2 0` cannot silently become `20`.
    const tokens = expression.match(/[+-]?\s*(?:\d*d\d+|\d+)/gu) ?? [];
    if (
      !tokens.length ||
      tokens.length > 20 ||
      tokens.join("").replace(/\s/gu, "") !== expression.replace(/\s/gu, "")
    )
      throw new Error("Некорректное выражение.");
    let diceCount = 0;
    const terms = tokens.map((token, index) => {
      const text = token.replace(/\s/gu, "");
      if (index > 0 && !/^[+-]/u.test(text)) throw new Error("Между слагаемыми нужен + или −.");
      const sign = text.startsWith("-") ? -1 : 1;
      const body = text.replace(/^[+-]/u, "");
      const dice = body.match(/^(\d*)d(\d+)$/u);
      const count = dice ? Number(dice[1] || 1) : 0;
      const sides = dice ? Number(dice[2]) : 0;
      const modifier = dice ? 0 : Number(body);
      diceCount += count;
      if (
        (dice && (count < 1 || count > 100 || sides < 2 || sides > 1000000)) ||
        modifier > 1000000 ||
        diceCount > 100
      )
        throw new Error("Лимиты: 100 кубов, от d2 до d1000000, модификатор до 1000000.");
      return { sign, count, sides, modifier };
    });
    if (!diceCount) throw new Error("Добавьте хотя бы один куб, например d20.");
    const values: string[] = [];
    let total = 0;
    for (const term of terms) {
      let subtotal = term.modifier;
      let detail = String(subtotal);
      if (term.count) {
        const rolls: string[] = [];
        subtotal = 0;
        for (let index = 0; index < term.count; index++) {
          const first = draw(term.sides);
          const second = mode ? draw(term.sides) : first;
          const kept =
            mode === "adv"
              ? Math.max(first, second)
              : mode === "dis"
                ? Math.min(first, second)
                : first;
          subtotal += kept;
          rolls.push(mode ? `(${first}, ${second} → ${kept})` : String(first));
        }
        detail = `[${rolls.join(" + ")}]`;
      }
      total += term.sign * subtotal;
      values.push(`${term.sign < 0 ? "− " : values.length ? "+ " : ""}${detail}`);
    }
    return `${values.join(" ")} = ${total}`;
  } catch (error) {
    return `${error instanceof Error ? error.message : "Ошибка броска."}\n${usage}`;
  }
}
