/** @file Verify private content cannot reach Discord send/edit payloads. */
import { expect, test } from "bun:test";
import type { Message } from "discord.js";
import { ActionRowBuilder, ButtonBuilder } from "discord.js";
import { createDiscordDelivery } from "../../src/adapters/discord/delivery.ts";
import { fixture } from "../support/fixtures.ts";

test.each([true, false])(
  "Discord filters every partial reasoning snapshot (closed=%s)",
  async (closed) => {
    const payloads: string[] = [];
    const reply = {
      async edit(payload: { content: string }) {
        payloads.push(payload.content);
      },
    };
    const delivery = createDiscordDelivery(
      fixture<Message>({
        async reply(payload: { content: string }) {
          payloads.push(payload.content);
          return reply;
        },
      }),
      null,
      new ActionRowBuilder<ButtonBuilder>(),
    );
    const raw = `Ответ.<think>private secret${closed ? "</think> Готово." : ""}`;
    for (let index = 1; index <= raw.length; index++)
      await delivery.flush({ text: raw.slice(0, index), status: "", final: false });
    await delivery.flush({ text: raw, status: "", final: true });
    expect(payloads.length).toBeGreaterThan(0);
    for (const text of payloads) expect(text).not.toMatch(/private|secret|[<>]/u);
    expect(payloads.at(-1)).toBe(closed ? "Ответ. Готово." : "Ответ.");
  },
);
