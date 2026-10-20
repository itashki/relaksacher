/** @file Verify mention name resolution before Discord speech synthesis. */
import { expect, test } from "bun:test";
import type { Message } from "discord.js";
import { discordSpeechText } from "../src/adapters/discord-speech-text.ts";

test("speech uses guild nicknames, resolves generated mentions once and preserves ordinary numbers", async () => {
  const fetched: string[] = [];
  const source = {
    guild: {
      members: {
        cache: new Map([["10", { displayName: "Алиса" }]]),
        fetch: async (id: string) => {
          fetched.push(id);
          return { displayName: "Борис" };
        },
      },
    },
    mentions: { users: new Map([["10", { username: "alice123" }]]) },
  } as unknown as Message;
  expect(await discordSpeechText("<@10>, привет! <@!20> и <@20>, число 125.", source)).toBe(
    "Алиса, привет! Борис и Борис, число 125.",
  );
  expect(fetched).toEqual(["20"]);
});

test("speech falls back to global names, usernames and a neutral word for unavailable users", async () => {
  const source = {
    guild: {
      members: {
        fetch: async () => {
          throw new Error("Unknown member");
        },
      },
    },
    mentions: {
      users: new Map([
        ["10", { globalName: "Маша", username: "masha123" }],
        ["20", { username: "ivan" }],
      ]),
    },
    client: {
      users: {
        cache: new Map(),
        fetch: async (id: string) => {
          if (id === "30") return { globalName: "Оля" };
          throw new Error("Unknown user");
        },
      },
    },
  } as unknown as Message;
  expect(await discordSpeechText("<@10> <@20> <@30> <@!40>", source)).toBe(
    "Маша ivan Оля пользователь",
  );
});
