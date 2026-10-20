/** @file Expand numbers and meaningful symbols into words accepted by speech models. */
const ruUnits = [
  "ноль",
  "один",
  "два",
  "три",
  "четыре",
  "пять",
  "шесть",
  "семь",
  "восемь",
  "девять",
];
const enUnits = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine"];
const ruTeens = [
  "десять",
  "одиннадцать",
  "двенадцать",
  "тринадцать",
  "четырнадцать",
  "пятнадцать",
  "шестнадцать",
  "семнадцать",
  "восемнадцать",
  "девятнадцать",
];
const enTeens = [
  "ten",
  "eleven",
  "twelve",
  "thirteen",
  "fourteen",
  "fifteen",
  "sixteen",
  "seventeen",
  "eighteen",
  "nineteen",
];
const ruTens = [
  "",
  "",
  "двадцать",
  "тридцать",
  "сорок",
  "пятьдесят",
  "шестьдесят",
  "семьдесят",
  "восемьдесят",
  "девяносто",
];
const enTens = [
  "",
  "",
  "twenty",
  "thirty",
  "forty",
  "fifty",
  "sixty",
  "seventy",
  "eighty",
  "ninety",
];
const ruHundreds = [
  "",
  "сто",
  "двести",
  "триста",
  "четыреста",
  "пятьсот",
  "шестьсот",
  "семьсот",
  "восемьсот",
  "девятьсот",
];
const scales = [
  ["", "", ""],
  ["тысяча", "тысячи", "тысяч"],
  ["миллион", "миллиона", "миллионов"],
  ["миллиард", "миллиарда", "миллиардов"],
  ["триллион", "триллиона", "триллионов"],
];
const enScales = ["", "thousand", "million", "billion", "trillion"];

/** Read an integer; preserve leading zeroes and very long identifiers digit by digit. */
function integerWords(digits: string, english: boolean): string {
  const units = english ? enUnits : ruUnits;
  if (/^0\d/u.test(digits) || digits.length > 15)
    return [...digits].map((digit) => units[Number(digit)]).join(" ");
  let value = Number(digits);
  if (!value) return units[0];
  const groups: string[] = [];
  for (let scale = 0; value; scale++, value = Math.floor(value / 1000)) {
    const group = value % 1000;
    if (!group) continue;
    const words: string[] = [];
    const hundreds = Math.floor(group / 100);
    if (hundreds) words.push(english ? `${units[hundreds]} hundred` : ruHundreds[hundreds]);
    const remainder = group % 100;
    if (remainder >= 10 && remainder < 20)
      words.push((english ? enTeens : ruTeens)[remainder - 10]);
    else {
      if (remainder >= 20) words.push((english ? enTens : ruTens)[Math.floor(remainder / 10)]);
      const unit = remainder % 10;
      if (unit)
        words.push(!english && scale === 1 && unit <= 2 ? ["", "одна", "две"][unit] : units[unit]);
    }
    if (scale) {
      const ending =
        remainder >= 11 && remainder <= 14
          ? 2
          : group % 10 === 1
            ? 0
            : group % 10 >= 2 && group % 10 <= 4
              ? 1
              : 2;
      words.push(english ? enScales[scale] : scales[scale][ending]);
    }
    groups.unshift(words.join(" "));
  }
  return groups.join(" ");
}

/** Expand numbers, decimals and common symbols; punctuation remains available for intonation.
 * Language must match the model chosen from the original text. Fractional digits are read separately.
 */
export function normalizeSpeechText(text: string, english: boolean): string {
  const units = english ? enUnits : ruUnits;
  const symbols: Record<string, string> = english
    ? {
        "@": "at",
        "%": "percent",
        "+": "plus",
        "-": "minus",
        "−": "minus",
        "=": "equals",
        "*": "times",
        "×": "times",
        "/": "slash",
        "÷": "divided by",
        "№": "number",
        "#": "hash",
        "&": "and",
        $: "dollars",
        "€": "euros",
        "₽": "rubles",
        "<": "less than",
        ">": "greater than",
        _: "underscore",
        "^": "caret",
      }
    : {
        "@": "собака",
        "%": "процентов",
        "+": "плюс",
        "-": "минус",
        "−": "минус",
        "=": "равно",
        "*": "умножить",
        "×": "умножить",
        "/": "слэш",
        "÷": "разделить на",
        "№": "номер",
        "#": "решётка",
        "&": "и",
        $: "долларов",
        "€": "евро",
        "₽": "рублей",
        "<": "меньше",
        ">": "больше",
        _: "нижнее подчёркивание",
        "^": "крышка",
      };
  return (
    text
      // These letters have no sound alone; preserve their normal spelling inside words.
      .replace(/(?<!\p{L})[ъь]+(?!\p{L})/giu, (signs) =>
        [...signs.toLowerCase()]
          .map((sign) => (sign === "ъ" ? "твёрдый знак" : "мягкий знак"))
          .join(" "),
      )
      .replace(/\d+(?:[.,]\d+)?/gu, (number) => {
        const [whole, fraction] = number.split(/[.,]/u);
        return ` ${integerWords(whole, english)}${fraction ? ` ${english ? "point" : "запятая"} ${[...fraction].map((digit) => units[Number(digit)]).join(" ")}` : ""} `;
      })
      .replace(/[@%+−=*×/÷№#&$€₽<>_^]|(?<!\p{L})-|-(?!\p{L})/gu, (symbol) => ` ${symbols[symbol]} `)
      .replace(/\s+/gu, " ")
      .trim()
  );
}
