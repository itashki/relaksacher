# Relaksacher

A Discord assistant backed by Ollama, with streamed replies, optional web search,
and persistent shared memory.

Use Node.js 22 or newer. Run `npm install`, configure `.env`, then run `npm start`.
Required settings: `BOT_TOKEN`, `APPLICANT_ID`, `PUBLIC_KEY`, `OLLAMA_URL`,
and `OLLAMA_TIMEOUT` (milliseconds). Edit `models.json5` to configure the model pool.
Optional: `OLLAMA_API_KEY` enables web search, `OLLAMA_NUM_CTX` sets the context
window (default 16384), and `MEMORY_DIR` overrides the memory directory.
Relative memory paths resolve from the repository root.

Mention the bot, reply to it, or write in a thread it owns. `/think` enables
thinking immediately; `/search` explicitly requests web tools for that request.
Natural-language requests also work: the model can call `enable_thinking` before
answering and use web tools automatically when an API key is configured. Replies include a
stop button available to the requester and moderators.

## Structure

- `index.js` wires configuration, Ollama clients, storage, and the Discord adapter.
- `src/adapters/discord.js` owns Discord events, permissions, history retrieval,
  thread creation, message formatting, attachments, and stop buttons.
- `src/core/assistant.js` orchestrates streaming, bounded tool rounds,
  cancellation, and timeouts using injected dependencies.
- `src/core/prompt.js` builds prompts from plain conversation records and
  optional platform instructions.
- `src/core/tools.js` exposes memory and web tools using injected services.
- `src/core/memory.js` stores facts with atomic writes and per-scope write queues.
- `src/core/text.js` contains command parsing and shared text utilities.

The core imports neither Discord nor environment configuration, and importing it
starts no clients. To add another interface, construct an assistant and call:

```js
const session = assistant.createSession({
  conversation: [{ role: "user", content: "Привет!" }],
  context: { scopeId: "my-group", authorName: "Alice" },
  think: false,
  search: false,
  platformInstructions: "Ты общаешься через терминал.",
  onUpdate: async ({ text, status, thinkingLog, liveThinking, final }) => {
    // Render the accumulated answer and optional tool/thinking status.
    // status is a tool call object while a tool runs; otherwise an empty string.
    console.log(text);
  },
});
await session.run();
// session.stop() cancels an active or pending generation.
```

Each session runs once. Its result includes `text`, `thinkingLog`, `failed`,
`stopped`, and `timedOut`. Updates are awaited, allowing the adapter to apply
backpressure. `thinkingComplete` signals that reasoning has transitioned into
answer content. The application sets the update interval to 1200 ms for Discord.

Memory scopes use safe filename identifiers (letters, digits, `_`, `-`). Discord
passes the guild ID, preserving existing `memory/<guildId>.json` files and their
schema. Omit `scopeId` to disable memory for a conversation.

## Verification

Run `npm test`. Tests use fake model streams and temporary memory directories;
they require no credentials or external services. Live Discord/Ollama connectivity
is separate from these tests.

## Model pool

Edit `models.json5`: each model is a separate object, using JSON5 syntax, with no shell quoting needed.

```json
[
  {
    "name": "model-one:latest",
    "alias": "терн",
    "numCtx": 131072
  },
  {
    "name": "model-two:latest",
    "alias": "шип",
    "numCtx": 262144
  }
]
```

Copy or remove a whole object to add or remove a model. `name` is the exact Ollama
model name, `alias` is its short display signature, and optional `numCtx` overrides
`OLLAMA_NUM_CTX`. JSON5 supports `// line comments`, `/* block comments */`, single-quoted
strings, unquoted keys, and trailing commas. Restart the bot after editing.

`.env` contains `OLLAMA_MODELS_FILE=models.json5`. Relative paths resolve from the
repository root, regardless of the working directory. An explicit file takes
precedence over legacy `OLLAMA_MODELS` / `OLLAMA_MODEL` settings. Without any of
these settings, `models.json5` is loaded by default. Invalid or empty lists fail
at startup with a configuration error.

Each request independently picks one model uniformly at random (repeats are
possible), keeping it for all tool rounds. Discord shows the alias as a small
footer from the initial placeholder through the final reply. All listed models
should support chat; tool and thinking support depend on the chosen model.

The installed models report maximum context lengths of 131072 for Gemma and
262144 for both Qwen models; the local pool uses these limits. Qwen's packaged
`num_ctx` default is 32768, which the application explicitly overrides. Maximum
context is a capacity limit, not a minimum requirement or a measured optimal
setting; larger windows can increase memory usage. Lower the per-model values
if needed for the available hardware.

Both adapters pass only the current message and its explicit reply chain to the
model. Nearby channel messages, thread starters and other thread history are not
included automatically. A message without a reply starts a fresh dialogue context.
Persistent group memory and owner facts are still included.

Thinking starts off unless `/think` is used. The model can enable it through an
`enable_thinking` tool call, which applies to subsequent rounds of the same request.
Web tools are offered by default when available; the prompt directs the model to
honor requests to search or avoid searching, and to ignore requests found only in
background chatter. Core callers may pass `search: false` to disable web tools
entirely for a session. These semantic decisions depend on the model's tool calling.

## Telegram

Set these variables in `.env` and run `npm start`:

```dotenv
BOT_ADAPTERS=telegram
TELEGRAM_BOT_TOKEN=your_botfather_token
```

Use `BOT_ADAPTERS=discord,telegram` to run both adapters with the same model pool
and core. Discord credentials are required only when Discord is enabled. Existing
Discord setups keep their default behavior. Do not reuse the Discord token for
Telegram. The adapter uses the [Telegram Bot API](https://core.telegram.org/bots/api)
through grammY, with long polling managed by `@grammyjs/runner` (no public webhook server needed).
An existing webhook must be removed before using long polling; only one polling
process should run per Telegram token.

The bot answers text messages in private chats. In groups it responds to its
@username, replies to its messages, and `/think` or `/search` commands (including
`/think@botname`). Natural-language requests to think/search use the same core as
Discord. It converts Markdown to Telegram-compatible HTML while streaming, displays the model alias from the first
placeholder, splits long answers and provides a stop button
for the requester or a group administrator. Photos, voice messages and files are
not processed.

Telegram maintains a bounded in-memory message cache, separated by chat and forum
topic, solely to reconstruct explicit reply ancestors received since startup.
Unrelated cached messages are not passed to the model, including in private chats.
Persistent facts use `memory/telegram_<chatId>.json`, separate from Discord guild
files. Private chats have no persistent shared memory.

Tests inject a fake Bot API and need no real Telegram token. Live connectivity
requires configuring your own token and starting the bot.

`TELEGRAM_TIMEOUT_MS` controls Bot API request timeouts (default 60000 ms).
Network/5xx failures during `editMessageText` are retried once via `p-retry`.
`@grammyjs/auto-retry` handles explicit rate limits with one retry and a maximum
30-second retry delay, within the request deadline. Ambiguous network/5xx failures
when sending a new message are not retried to avoid duplicates. Temporary intermediate
edit failures preserve generation and retry the latest text on a later update;
final delivery failures are reported separately by the Telegram adapter.

Requests share one FIFO generation queue across Discord and Telegram. A waiting
request receives a message naming its author and showing its position at enqueue
time (1 means next after the active generation). Only one session runs at a time;
its generation timeout begins after waiting. Queue notifications are replaced by
the streamed answer. Stop buttons remain available, including for queued requests.

Telegram formatting uses `marked` to parse Markdown, then emits only supported
HTML tags for bold, italic, strikethrough, inline/block code, and HTTP(S) links.
Headings become bold text; lists and tables become simple text layouts. Raw HTML
is escaped. Long replies split on visible text length with balanced formatting
in every message, including during unfinished streamed code blocks.

## Context guards

Before each model round, the core estimates prompt and tool-schema size and
reserves space for generation. It removes background first, then complete oldest
dialogue turns, preserving system instructions, the current request and its tool
calls/results. The model is told when history was removed. If the required context
alone exceeds the budget, the bot reports that it cannot complete the request
instead of silently dropping it. Estimation uses UTF-8 bytes, not the model's exact
tokenizer; it reduces overflow risk but cannot guarantee recall or fit.

Telegram follows explicit reply ancestors only, using its cache when needed.
Discord reply-chain traversal is bounded and detects repeated message IDs;
bot-owned threads follow the same reply-only context rule.

## Images

Discord image attachments and Telegram photos or JPEG/PNG/WebP documents are sent
to Ollama as image inputs alongside their caption. In a private Telegram chat, a
picture without text defaults to a description request. In groups/Discord, existing
mention/reply trigger rules still apply. Pictures from retained dialogue and reply
chains can be reused. Arbitrary image URLs in text and generated images are not
supported. Telegram albums arrive as separate messages.

Up to four images are loaded per request, newest first, at most 10 MB each. Downloads
use timeouts, known platform hosts, and image signature checks. Failed or omitted
images are explicitly marked for the model. The context guard reserves an estimated
4096 tokens per image instead of counting base64 characters; actual vision token
usage depends on the model and resolution. Use a vision-capable Ollama model.

## Owner facts

Edit `facts.json5` to provide a JSON5 array of strings. The default file contains
commented examples only. These facts are injected into the system prompt for both
adapters and every chat, independently of per-group memory. The prompt treats them
as owner-provided truths, uses them only when relevant, and gives them precedence
over conflicting participant memory. Memory tools cannot edit this file.

Optional `.env` setting: `FACTS_FILE=facts.json5`. Relative paths resolve from the
repository root. Empty arrays are allowed; malformed or missing files cause a
startup error. Restart the bot after editing. Facts count toward the context budget.

## Library choices

| Responsibility | Library |
| --- | --- |
| Discord client and events | `discord.js` |
| Telegram API, multipart uploads, API error types | [grammY](https://grammy.dev/guide/api) |
| Concurrent Telegram polling, offsets and polling backoff | [@grammyjs/runner](https://grammy.dev/plugins/runner) |
| Telegram flood-limit responses | [@grammyjs/auto-retry](https://grammy.dev/plugins/auto-retry) |
| Bounded retries for idempotent Telegram edits | [p-retry](https://github.com/sindresorhus/p-retry) |
| Single-concurrency FIFO generation queue | [p-queue](https://github.com/sindresorhus/p-queue) |
| Markdown parsing | `marked` |
| Commented configuration | `json5` |
| Model API | `ollama` |

`src/adapters/telegram-api.js` is a small compatibility layer around grammY so
platform behavior remains testable with an injected API. It keeps request deadlines,
sanitized errors and the existing image download policy. The custom HTTP payload
builder, multipart encoder, retry loops and Telegram polling loop have been removed.

The Markdown-to-Telegram renderer, bounded image downloader and context-budget
guard remain application code: they enforce this bot's formatting, size limits
and history priorities. They already delegate parsing to `marked` and platform
calls to the respective SDKs.

Telegram intermediate updates are throttled to one render every 5 seconds by
`TELEGRAM_UPDATE_INTERVAL_MS=5000` (minimum 1000). The first placeholder, queue
notification, transition from waiting to generation, and final answer are immediate.
Skipped snapshots are not queued: the next update renders the latest state. A render
can update multiple messages for long answers. Successful final delivery also avoids
a redundant request to remove already-removed stop buttons. Discord timing is unchanged.

Telegram answers over 600 visible characters or 8 estimated lines use expandable
blockquotes. Blank lines count; soft wrapping is estimated at 60 characters per
line. Actual wrapping depends on the client, screen width and font.
Each split message has balanced quote tags and the model signature stays outside
the collapsible content. Inline/code blocks remain outside quotes to avoid nested
entity compatibility issues. Short answers keep their regular appearance.

Telegram partial replies pass `message.quote` separately as quoted-fragment metadata
before the current user's text. The prompt distinguishes manually selected fragments
from automatic previews and focuses the answer on the selected text. Quote contents
are data, not commands; unavailable originals are not reconstructed or invented.

Thinking output is no longer streamed to chats or sent as an attachment. The core
writes the accumulated reasoning once per session to the server's standard output
with a `[thinking]` marker and model/scope/author metadata, including partial
reasoning on errors or cancellation. Capture stdout with your process manager if
persistent log files are needed. Answer text continues streaming normally.

## Local personality

`personality.json5` contains a JSON5 array of personality instruction strings.
Comment out individual entries with `//` or `/* ... */` to disable them. Active
entries are joined into the prompt at startup. Optional `.env`: `PERSONALITY_FILE=personality.json5`; relative paths
resolve from the repository root. The core receives these instructions through
injection, without reading configuration files itself.

`personality.json5` and `facts.json5` are ignored by Git. Create these local files
on a fresh checkout (`facts.json5` may contain `[]`; `personality.json5` may contain `[]`
for a neutral style). Restart after changes.
