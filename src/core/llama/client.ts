/** @file OpenAI-compatible streaming chat client for the llama-server managed by `servers.ts`. */
import type { ChatMessage, ModelClient, ModelPart, ModelRequest } from "../../types.ts";
import { llamaOrigin, type createModelServers } from "./servers.ts";

type Servers = Pick<ReturnType<typeof createModelServers>, "use">;
type Call = { id: string; name: string; arguments: string };

/** Convert Ollama-style history to OpenAI messages. Tool calls without an id get the
 * deterministic `call_<messageIndex>_<i>`; each `tool` message takes the next unused id of the
 * preceding assistant message. */
function toOpenAiMessages(messages: ChatMessage[]) {
  let pending: string[] = [];
  return messages.map((m, index) => {
    if (m.role === "tool")
      return { role: "tool", content: m.content, tool_call_id: pending.shift() };
    if (m.role === "assistant") {
      const calls = (m.tool_calls ?? []).map((c, i) => ({
        id: (c as { id?: string }).id ?? `call_${index}_${i}`,
        type: "function",
        function: { name: c.function.name, arguments: JSON.stringify(c.function.arguments) },
      }));
      pending = calls.map((c) => c.id);
      return {
        role: "assistant",
        content: m.content,
        ...(calls.length && { tool_calls: calls }),
        ...(m.thinking && { reasoning_content: m.thinking }),
      };
    }
    if (!m.images?.length && !m.videos?.length) return { role: m.role, content: m.content };
    const image = (b64: string) => ({
      type: "image_url",
      image_url: { url: `data:image/jpeg;base64,${b64}` },
    });
    const video = (b64: string) => ({
      type: "input_video",
      input_video: { data: `data:video/mp4;base64,${b64}` },
    });
    return {
      role: m.role,
      content: [
        { type: "text", text: m.content },
        ...(m.images ?? []).map((i) => image(i as string)),
        ...(m.videos ?? []).map(video),
      ],
    };
  });
}

function toBody(request: ModelRequest) {
  const { options, format } = request;
  return {
    model: request.model,
    stream: true,
    messages: toOpenAiMessages(request.messages ?? []),
    tools: request.tools,
    chat_template_kwargs: { enable_thinking: Boolean(request.think) },
    ...(format && typeof format === "object"
      ? { response_format: { type: "json_schema", json_schema: { schema: format } } }
      : {}),
    ...(options?.num_predict !== undefined && { max_tokens: options.num_predict }),
    ...(options?.temperature !== undefined && { temperature: options.temperature }),
  };
}

/** Yield parsed SSE `data:` payloads until `[DONE]`. */
async function* events(body: ReadableStream<Uint8Array>) {
  let buffer = "";
  for await (const chunk of body.pipeThrough(
    new TextDecoderStream() as ReadableWritablePair<string, Uint8Array>,
  )) {
    buffer += chunk;
    for (let nl = buffer.indexOf("\n"); nl >= 0; nl = buffer.indexOf("\n")) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (data === "[DONE]") return;
      yield JSON.parse(data);
    }
  }
}

async function* parts(body: ReadableStream<Uint8Array>): AsyncGenerator<ModelPart> {
  const calls: Call[] = [];
  for await (const event of events(body)) {
    if (event.error) throw new Error(event.error.message ?? JSON.stringify(event.error));
    const choice = event.choices?.[0];
    if (!choice) continue;
    const { delta = {}, finish_reason: reason } = choice;
    if (delta.content) yield { message: { content: delta.content } };
    if (delta.reasoning_content) yield { message: { thinking: delta.reasoning_content } };
    for (const t of delta.tool_calls ?? []) {
      const call = (calls[t.index ?? 0] ??= { id: "", name: "", arguments: "" });
      call.id ||= t.id ?? "";
      call.name ||= t.function?.name ?? "";
      call.arguments += t.function?.arguments ?? "";
    }
    if (reason)
      yield {
        done: true,
        done_reason: reason,
        message: {
          content: "",
          tool_calls: calls.filter(Boolean).map((c) => ({
            id: c.id,
            function: { name: c.name, arguments: parseArguments(c.arguments) },
          })),
        },
      };
  }
}

/** Unparsable arguments become `{}`; the tool's own validation reports the problem. */
function parseArguments(text: string): Record<string, unknown> {
  try {
    return JSON.parse(text || "{}");
  } catch {
    return {};
  }
}

/** Create a `ModelClient` posting to `${url}/v1/chat/completions` under the `servers` lock.
 * `chat` resolves once the response is OK; a non-OK response rejects with the server's
 * `error.message`. The lock is held until the stream ends, throws, is broken out of, or
 * `abort()` is called, so callers MUST read the stream to the end or call `abort()`, even when
 * the stream resolves after they gave up. Release is idempotent. */
export function createLlamaClient({
  servers,
  url = llamaOrigin,
  fetchImpl = fetch,
}: {
  servers: Servers;
  url?: string;
  fetchImpl?: typeof fetch;
}): ModelClient {
  return {
    chat: (request) =>
      new Promise((resolve, reject) => {
        void servers
          .use(request.model, async () => {
            const controller = new AbortController();
            let release!: () => void;
            const released = new Promise<void>((r) => (release = r));
            const response = await fetchImpl(`${url}/v1/chat/completions`, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify(toBody(request)),
              signal: controller.signal,
            });
            if (!response.ok || !response.body) {
              const failure = await response.json().catch((): undefined => undefined);
              throw new Error(
                failure?.error?.message ?? `llama-server returned ${response.status}`,
              );
            }
            const body = response.body;
            const inner = parts(body);
            const stream: AsyncGenerator<ModelPart> & { abort(): void } = Object.assign(
              (async function* (): AsyncGenerator<ModelPart> {
                try {
                  yield* inner;
                } finally {
                  release();
                }
              })(),
              {
                abort() {
                  controller.abort();
                  release();
                },
              },
            );
            resolve(stream);
            await released;
          })
          .catch(reject);
      }),
  };
}
