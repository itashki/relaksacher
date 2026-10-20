/** @file Verify voice replacement, attribution and chunk deduplication for chat-history tools. */
import { expect, test } from "bun:test";
import { createTranscriptHistory } from "../../src/core/memory/transcript-history.ts";

test("history substitutes the original voice and removes all delivery chunks and presentation markers", () => {
  const history = createTranscriptHistory();
  history.remember({ id: "voice", author: "Alice", content: "Распознанная речь" }, [
    "reply1",
    "reply2",
  ]);
  expect(
    history.normalize([
      { id: "before", author: "Bob", content: "до" },
      { id: "voice", author: "Alice", content: "" },
      { id: "reply1", author: "bot", content: "🎙 Транскрипция:\nРаспознанная" },
      { id: "reply2", author: "bot", content: "речь" },
      { id: "after", author: "Bob", content: "после" },
    ]),
  ).toEqual([
    { id: "before", author: "Bob", content: "до" },
    { id: "voice", author: "Alice", content: "Распознанная речь" },
    { id: "after", author: "Bob", content: "после" },
  ]);
});

test("history retains a single full transcript when only delivery chunks fall within the fetched window", () => {
  const history = createTranscriptHistory();
  history.remember({ id: "voice", author: "Alice", content: "Полный текст" }, ["reply1", "reply2"]);
  expect(
    history.normalize([
      { id: "reply1", author: "bot", content: "🎙 Транскрипция:" },
      { id: "reply2", author: "bot", content: "текст" },
    ]),
  ).toEqual([{ id: "voice", author: "Alice", content: "Полный текст" }]);
});
