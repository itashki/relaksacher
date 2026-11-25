/** @file Verify the llama-server client: request shape, SSE mapping and lock lifetime. */
import { expect, test } from "bun:test";
import { createLlamaClient } from "../../src/core/llama/client.ts";
import { createModelServers } from "../../src/core/llama/servers.ts";
import type { ModelPart, ModelRequest } from "../../src/types.ts";

const sse = (...events: unknown[]) =>
  events.map((e) => `data: ${typeof e === "string" ? e : JSON.stringify(e)}\n\n`).join("");
const delta = (d: object, finish_reason?: string) => ({ choices: [{ delta: d, finish_reason }] });

/** Client over real servers with a fake fetch; every call is recorded in `calls`. */
function setup(respond: () => Response = () => new Response(sse(delta({}, "stop"), "[DONE]"))) {
  const calls: { body: any; signal: AbortSignal }[] = [];
  const servers = createModelServers({
    create: () => ({ start: async () => {}, stop: async () => {} }),
  });
  const fetchImpl = (async (_url: string, init: RequestInit) => {
    calls.push({ body: JSON.parse(init.body as string), signal: init.signal as AbortSignal });
    return respond();
  }) as unknown as typeof fetch;
  return { calls, client: createLlamaClient({ servers, fetchImpl }) };
}
const base = { model: "m", stream: true } as const;
const collect = async (s: AsyncIterable<ModelPart>) => {
  const out: ModelPart[] = [];
  for await (const p of s) out.push(p);
  return out;
};

test("maps content, reasoning and fragmented tool calls", async () => {
  const tc = (arguments_: string, extra = {}) =>
    delta({ tool_calls: [{ index: 0, function: { arguments: arguments_ }, ...extra }] });
  const { client } = setup(
    () =>
      new Response(
        sse(
          delta({ reasoning_content: "hm" }),
          delta({ content: "hi" }),
          tc("", { id: "c1", function: { name: "get", arguments: '{"city"' } }),
          tc(':"М"}'),
          delta({}, "tool_calls"),
          "[DONE]",
        ),
      ),
  );
  const parts = await collect(await client.chat({ ...base, messages: [] }));
  expect(parts).toEqual([
    { message: { thinking: "hm" } },
    { message: { content: "hi" } },
    {
      done: true,
      done_reason: "tool_calls",
      message: {
        content: "",
        tool_calls: [{ id: "c1", function: { name: "get", arguments: { city: "М" } } }],
      },
    },
  ]);
});

test("builds the request body", async () => {
  const { client, calls } = setup();
  const request: ModelRequest = {
    ...base,
    think: true,
    format: { type: "object" },
    options: { num_predict: 32, temperature: 0, num_ctx: 9 },
    messages: [
      { role: "user", content: "q", images: ["AA"], videos: ["VV"] },
      {
        role: "assistant",
        content: "",
        thinking: "t",
        tool_calls: [{ id: "x", function: { name: "f", arguments: { a: 1 } } } as never],
      },
      { role: "tool", content: "r", tool_name: "f" },
      { role: "assistant", content: "", tool_calls: [{ function: { name: "g", arguments: {} } }] },
      { role: "tool", content: "r2", tool_name: "g" },
    ],
  };
  await collect(await client.chat(request));
  await collect(await client.chat({ ...base, think: false }));
  await collect(await client.chat(base));
  const [{ body }, off, absent] = calls;
  expect(off!.body.chat_template_kwargs).toEqual({ enable_thinking: false });
  expect(absent!.body.chat_template_kwargs).toEqual({ enable_thinking: false });
  expect(body.chat_template_kwargs).toEqual({ enable_thinking: true });
  expect(body.response_format).toEqual({
    type: "json_schema",
    json_schema: { schema: { type: "object" } },
  });
  expect(body.max_tokens).toBe(32);
  expect(body.temperature).toBe(0);
  expect(JSON.stringify(body)).not.toContain("num_ctx");
  expect(body.messages[0].content).toEqual([
    { type: "text", text: "q" },
    { type: "image_url", image_url: { url: "data:image/jpeg;base64,AA" } },
    { type: "input_video", input_video: { data: "data:video/mp4;base64,VV" } },
  ]);
  expect(body.messages[1]).toEqual({
    role: "assistant",
    content: "",
    reasoning_content: "t",
    tool_calls: [{ id: "x", type: "function", function: { name: "f", arguments: '{"a":1}' } }],
  });
  expect(body.messages[2].tool_call_id).toBe("x");
  expect(body.messages[3].tool_calls[0].id).toBe("call_3_0");
  expect(body.messages[4].tool_call_id).toBe("call_3_0");
});

test("non-OK response rejects with the server message", async () => {
  const { client } = setup(
    () =>
      new Response(JSON.stringify({ error: { message: "image input is not supported" } }), {
        status: 500,
      }),
  );
  await expect(client.chat(base)).rejects.toThrow("image input is not supported");
});

test("the lock covers the whole stream, also after abort of an unstarted stream", async () => {
  const { client, calls } = setup();
  const first = await client.chat(base);
  const second = client.chat(base);
  await Bun.sleep(10);
  expect(calls).toHaveLength(1);
  await collect(first);
  const next = await second;
  const third = client.chat(base);
  await Bun.sleep(10);
  expect(calls).toHaveLength(2);
  next.abort();
  await third;
  expect(calls[1]!.signal.aborted).toBe(true);
  expect(calls).toHaveLength(3);
});
