/** @file Verify speech expansion for quantities, identifiers, symbols and punctuation. */
import { expect, test } from "bun:test";
import { normalizeSpeechText } from "../src/core/speech-text.ts";

test("Russian numbers preserve magnitude, thousand gender and identifier zeroes", () => {
  for (const [input, output] of [
    ["0 11 125", "ноль одиннадцать сто двадцать пять"],
    ["1000 2002 11000 21000", "одна тысяча две тысячи два одиннадцать тысяч двадцать одна тысяча"],
    ["1000001 2000000000", "один миллион один два миллиарда"],
    [
      "001 1234567890123456",
      "ноль ноль один один два три четыре пять шесть семь восемь девять ноль один два три четыре пять шесть",
    ],
    ["-12,05 + 3 = 5", "минус двенадцать запятая ноль пять плюс три равно пять"],
  ])
    expect(normalizeSpeechText(input, false)).toBe(output);
});

test("at signs are spoken alone, attached to names and inside email addresses", () => {
  expect(normalizeSpeechText("@", false)).toBe("собака");
  expect(normalizeSpeechText("@Вася test@example.com", false)).toBe(
    "собака Вася test собака example.com",
  );
  expect(normalizeSpeechText("@user test@example.com", true)).toBe("at user test at example.com");
});

test("carets and isolated hard/soft sign runs are pronounced without changing words", () => {
  expect(normalizeSpeechText("^^ Ъь", false)).toBe("крышка крышка твёрдый знак мягкий знак");
  expect(normalizeSpeechText("^", true)).toBe("caret");
  expect(normalizeSpeechText("Объезд, соль, подъём, мышь.", false)).toBe(
    "Объезд, соль, подъём, мышь.",
  );
});

test("common symbols are spoken while sentence punctuation and word hyphens remain", () => {
  expect(normalizeSpeechText("50% №2 3×4=12 6÷2 ₽ $ € # & / _ < >", false)).toBe(
    "пятьдесят процентов номер два три умножить четыре равно двенадцать шесть разделить на два рублей долларов евро решётка и слэш нижнее подчёркивание меньше больше",
  );
  expect(normalizeSpeechText("Кто-то сказал: привет, мир!", false)).toBe(
    "Кто-то сказал: привет, мир!",
  );
  expect(normalizeSpeechText("1234.05 + 2 = 1236.05", true)).toBe(
    "one thousand two hundred thirty four point zero five plus two equals one thousand two hundred thirty six point zero five",
  );
});
