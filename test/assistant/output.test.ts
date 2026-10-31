/** @file Regression coverage for author-header leakage without stripping roleplay or literal examples. */
import { expect, test } from "bun:test";
import { cleanAssistantText } from "../../src/core/assistant/output.ts";
import { setup } from "../support/assistant-fixture.ts";

const header = "[Автор: Бот (username: bot, id: 123456)]";

test.each(["think", "analysis", "THINK"])("%s blocks never appear at any stream split", (tag) => {
  const raw = `До.<${tag}>private secret</${tag}>После.`;
  for (let index = 1; index <= raw.length; index++) {
    const text = cleanAssistantText(raw.slice(0, index), false);
    expect(text).not.toMatch(/private|secret|[<>]/u);
  }
  expect(cleanAssistantText(raw)).toBe("До.После.");
});

test("unclosed, nested and repeated reasoning blocks fail closed", () => {
  expect(cleanAssistantText("<think>secret")).toBe("");
  expect(cleanAssistantText("Ответ<think>secret</think><analysis>hidden</analysis>!")).toBe(
    "Ответ!",
  );
  expect(cleanAssistantText("<think>one<analysis>two</analysis>three</think>Ответ")).toBe("Ответ");
  expect(cleanAssistantText("<think  ")).toBe("");
  expect(cleanAssistantText("Обычный <b>текст</b> и 2 < 3.")).toBe("Обычный <b>текст</b> и 2 < 3.");
});

test.each([true, false])(
  "reasoning in content stays private through the session (closed=%s)",
  async (closed) => {
    const raw = `<think>private secret${closed ? "</think>Ответ." : ""}`;
    const env = setup([[...raw].map((content) => ({ message: { content } }))]);
    const result = await env.assistant.createSession(env.options).run();
    for (const text of [...env.updates.map((update) => update.text), result.text])
      expect(text).not.toMatch(/private|secret|[<>]/u);
    if (closed) expect(result.text).toBe("Ответ.");
    else expect(result.incompleteReason).toBe("empty_answer");
  },
);

test("recipe regression hides reasoning before and after a tool round", async () => {
  const call = { function: { name: "save_fursona", arguments: { profile: "fox" } } };
  const env = setup([
    [
      ...[..."<think>We need answer user's request in Russian. Call save_fursona.</think>"].map(
        (content) => ({ message: { content } }),
      ),
      { message: { content: "", tool_calls: [call] } },
    ],
    [
      ..."<think>Need final answer. Ensure no tool mention.</think>Пирог: выпекай при 180 °C 35–45 минут.",
    ].map((content) => ({ message: { content } })),
  ]);
  const result = await env.assistant.createSession(env.options).run();
  expect(result.text.trim()).toBe("Пирог: выпекай при 180 °C 35–45 минут.");
  for (const update of env.updates)
    expect(update.text).not.toMatch(/We need|Call save|Need final|[<>]/u);
  expect(env.requests[1].messages.find((message) => message.role === "assistant")?.content).toBe(
    "",
  );
});

test("author metadata is removed while conversational prose and roleplay actions remain", () => {
  const answer = "Привет! Всё хорошо.\n\n*Подмигиваю и шевелю ушами.*";
  expect(cleanAssistantText(`${header}\n\n${answer}`)).toBe(answer);
  expect(cleanAssistantText(`${header} ${answer}`)).toBe(answer);
  expect(cleanAssistantText(`${header}\\n${answer}`)).toBe(answer);
  expect(cleanAssistantText(`[author: Bot]\n${header}\n${answer}`)).toBe(answer);
  expect(cleanAssistantText(`До поиска.\n\n${header}\nПосле поиска.`)).toBe(
    "До поиска.\n\nПосле поиска.",
  );
});

test("partial headers stay hidden for every streaming split", () => {
  const raw = `${header}\n\nПривет! *Машу лапой.*`;
  for (let index = 1; index < raw.length; index++) {
    const visible = cleanAssistantText(raw.slice(0, index), false);
    expect(visible).not.toContain("Автор");
    expect(visible).not.toContain("username");
    expect(visible).not.toContain("123456");
    if (index <= header.length) expect(visible).toBe("");
  }
  expect(cleanAssistantText("[Автор: Бот (id: 123", true)).toBe("");
  expect(cleanAssistantText("[", false)).toBe("");
  expect(cleanAssistantText("[", true)).toBe("[");
});

test("ordinary Markdown, inline mentions, quotes and fenced code examples are preserved", () => {
  for (const text of [
    "[ссылка](https://example.org)",
    "Обозначение [Автор: Алиса] показывает автора.",
    "> [Автор: Алиса]\nЦитата.",
    "```text\n[Автор: Алиса]\n```",
    "~~~~\n[Автор: Алиса]\n```\n~~~~",
    "Привет!\n\n*Виляю хвостом.*",
  ])
    expect(cleanAssistantText(text)).toBe(text);
});

test("brackets in display names and whitespace before the colon do not leak partial metadata", () => {
  const raw = "[Автор : [Бот] (username: bot, id: 123456)] Привет!";
  for (let index = 1; index < raw.length; index++)
    expect(cleanAssistantText(raw.slice(0, index), false)).toBe("");
  expect(cleanAssistantText(raw)).toBe("Привет!");
  expect(cleanAssistantText("[Автор: [Бот] (username: bot, id: 123")).toBe("");
});

test("streamed updates, terminal and cached final result never expose generated headers", async () => {
  const raw = `${header}\n\nПривет!\n*Подмигиваю.*`;
  const env = setup([[...raw].map((content) => ({ message: { content } }))]);
  const terminal: string[] = [];
  env.assistant.subscribeTerminal((state) => {
    if (state.current?.text) terminal.push(state.current.text);
  });
  const result = await env.assistant.createSession(env.options).run();
  expect(result.text).toBe("Привет!\n*Подмигиваю.*");
  for (const text of [...env.updates.map((update) => update.text), ...terminal]) {
    expect(text).not.toContain("Автор");
    expect(text).not.toContain("123456");
  }
});

test("an answer containing only a generated header is reported as empty", async () => {
  const env = setup([[{ message: { content: header } }]]);
  const result = await env.assistant.createSession(env.options).run();
  expect(result.incompleteReason).toBe("empty_answer");
  expect(result.text).not.toContain("Автор");
  expect(result.text).toContain("модель не вернула текст ответа");
});
