/** @file Repetition detection across arbitrary streaming boundaries. */
import { expect, test } from "bun:test";
import { createRepetitionDetector } from "../src/core/repetition.ts";

test("allows four copies and detects the fifth across character chunks", () => {
  const detector = createRepetitionDetector();
  for (const char of "Нужно проверить результат. ".repeat(4)) {
    expect(detector.push(char)).toBe(false);
  }
  let detected = false;
  for (const char of "Нужно проверить результат. ") detected ||= detector.push(char);
  expect(detected).toBe(true);
});

test("detects a loop within a single chunk and ignores whitespace differences", () => {
  expect(
    createRepetitionDetector().push("check now\ncheck now  check now\tcheck now check now done"),
  ).toBe(true);
});

test("allows varied prose and punctuation runs", () => {
  const detector = createRepetitionDetector();
  expect(detector.push("One two three four five six seven eight nine ten")).toBe(false);
  expect(detector.push("\n--- --- --- --- ---\nа а а а а")).toBe(false);
});
