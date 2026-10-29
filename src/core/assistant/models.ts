/** @file Select a vision model per conversation and adapt requests to non-thinking Ollama models. */
import type { ChatRequest } from "ollama";
import type { AssistantOptions, ChatMessage, ModelStream } from "../../types.ts";

/** Keep every round on the vision model when any explicit conversation message contains images. */
export function createModelRouter(textModel: string, visionModel = textModel) {
  return (conversation: ChatMessage[]) =>
    conversation.some((message) => Boolean(message.images?.length)) ? visionModel : textModel;
}

/**
 * Retry only Ollama's explicit unsupported-thinking rejection without the think field.
 * Remember the result per model; leave tool schemas, input images and unrelated errors intact.
 * Requests to thinking-capable models retain their original settings.
 */
export function createModelChat(client: AssistantOptions["modelClient"]) {
  const nonThinking = new Set<string>();
  return async (request: ChatRequest & { stream: true }): Promise<ModelStream> => {
    const options = nonThinking.has(request.model) ? { ...request, think: undefined } : request;
    try {
      return await client.chat(options);
    } catch (error) {
      if (
        options.think === undefined ||
        error.status_code !== 400 ||
        !/does not support thinking/i.test(error.message)
      )
        throw error;
      nonThinking.add(request.model);
      console.info("[model] Native thinking unavailable; continuing without it:", request.model);
      return await client.chat({ ...request, think: undefined });
    }
  };
}
