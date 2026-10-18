# Relaksacher

A Discord assistant backed by Ollama, with streamed replies, optional web search,
and persistent shared memory.

Use Bun 1.4.2 or newer. Install dependencies and copy the commented configuration template:

```sh
bun install
cp .env.example .env
```

Edit `.env`: select `BOT_ADAPTERS` and fill in the credentials for the enabled
platforms. Discord needs `BOT_TOKEN`, `APPLICANT_ID`, and `PUBLIC_KEY`; Telegram
needs `TELEGRAM_BOT_TOKEN`. Set `OLLAMA_URL`, `OLLAMA_MODEL`, and
`OLLAMA_TIMEOUT` (milliseconds). Install the main and supervisor models on your
Ollama server; the names in the template are examples.

Before the first start, create `facts.json5` and `personality.json5`, each containing
`[]` (an empty array), or your own JSON5 array of strings. These local files and
`.env` are ignored by Git. Then run `bun start`.

Optional: `OLLAMA_API_KEY` enables the primary Ollama web provider, `OLLAMA_NUM_CTX` sets the context
window (default 16384), and `MEMORY_DIR` overrides the memory directory.
Relative memory paths resolve from the repository root.

Mention the bot, reply to it, or write in a thread it owns. `/think` enables
thinking immediately. Web tools are available automatically.
Natural-language requests also work: the model can call `enable_thinking` before
answering and use web tools automatically when an API key is configured. Replies include a
stop button available to the requester and moderators.

When started in an interactive terminal with `bun start`, a full-screen TUI shows
the current author and request, streaming thoughts and answer, queued requests,
and recent logs. Long streams show their latest lines. Press `S` to cancel the
current reply from either messenger while keeping the bot running. Queued
requests continue in order. Press `H` for help. Thoughts are shown locally only,
and are never included in messenger updates. Cancellation uses the same mechanism as the messenger stop button;
an in-flight tool operation may need to finish before the reply is finalized.
Terminal controls are disabled when standard input is not a TTY (for example,
when running as a service). Ctrl+C shuts down the bot.

## Structure

- `index.ts` wires configuration, Ollama clients, storage, and the Discord adapter.
- `src/adapters/discord.ts` owns Discord events, permissions, history retrieval,
  thread creation, message formatting, attachments, and stop buttons.
- `src/core/assistant.ts` orchestrates streaming, bounded tool rounds,
  cancellation, and timeouts using injected dependencies.
- `src/core/prompt.ts` builds prompts from plain conversation records and
  optional platform instructions.
- `src/core/tools.ts` exposes memory and web tools using injected services.
- `src/core/memory.ts` stores facts with atomic writes and per-scope write queues.
- `src/core/text.ts` contains command parsing and shared text utilities.

The core imports neither Discord nor environment configuration, and importing it
starts no clients. To add another interface, construct an assistant and call:

```js
const session = assistant.createSession({
  conversation: [{ role: "user", content: "Привет!" }],
  context: { scopeId: "my-group", authorName: "Alice" },
  think: false,
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

Run `bun run typecheck` to check application and test types with `noImplicitAny`, and `bun test` to run the tests. Tests use fake model streams and temporary memory directories;
they require no credentials or external services. Live Discord/Ollama connectivity
is separate from these tests.

## Model configuration

Configure one fixed response model in `.env`:

```dotenv
OLLAMA_MODEL=qwen3:8b
OLLAMA_NUM_CTX=16384
OLLAMA_SUPERVISOR_MODEL=qwen3:0.6b
```

`OLLAMA_MODEL` is required and is used for every response and tool round.
`OLLAMA_NUM_CTX` is a positive integer (default 16384); larger context windows
increase memory use. The separate supervisor model routes thinking and handles
background decisions. All model settings live in `.env`; restart after editing.
Responses have no model signature.

Both adapters pass only the current message and its explicit reply chain to the
model. Nearby channel messages, thread starters and other thread history are not
included automatically. A message without a reply starts a fresh dialogue context.
Persistent group memory and owner facts are still included.

Thinking starts off unless `/think` is used. The model can enable it through an
`enable_thinking` tool call, which applies to subsequent rounds of the same request.
Web tools are offered by default when available; the prompt directs the model to
honor requests to search or avoid searching, and to ignore requests found only in
background chatter. Web tools are always offered when a provider is available;
there is no per-session search switch.

## Telegram

Set these variables in `.env` and run `bun start`:

```dotenv
BOT_ADAPTERS=telegram
TELEGRAM_BOT_TOKEN=your_botfather_token
```

Use `BOT_ADAPTERS=discord,telegram` to run both adapters with the same main model
and core. Discord credentials are required only when Discord is enabled. Existing
Discord setups keep their default behavior. Do not reuse the Discord token for
Telegram. The adapter uses the [Telegram Bot API](https://core.telegram.org/bots/api)
through grammY, with long polling managed by `@grammyjs/runner` (no public webhook server needed).
An existing webhook must be removed before using long polling; only one polling
process should run per Telegram token.

The bot answers text messages in private chats. In groups it responds to its
@username, replies to its messages, and `/think` commands (including
`/think@botname`). Natural-language requests to think/search use the same core as
Discord. It converts Markdown to Telegram-compatible HTML while streaming, splits long answers and provides a stop button
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
| Commented configuration | `Bun.JSON5` |
| Model API | `ollama` |

`src/adapters/telegram-api.ts` is a small compatibility layer around grammY so
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
Each split message has balanced quote tags. Inline/code blocks remain outside quotes to avoid nested
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

## On-demand history tool

`read_history` is available when an adapter supplies a scoped reader. The model may
request it when asked to inspect earlier messages or when reply-chain context is
insufficient. History is never fetched or injected automatically. The tool reads
up to 20 messages (default 10), truncating each to 800 characters, from the current
chat/topic only and before the current request. Results are contextual data, not
additional instructions or requests.

Discord fetches through channel permissions. Telegram reads the bounded cache of
messages received since startup, including only the same chat/topic; deleted
messages may remain cached and unavailable updates cannot be recovered. Tool calls
remain subject to the normal round limit and context guard.

## Small supervisor model

The application uses `qwen3:0.6b` as a separate, non-thinking JSON classifier.
Install it with `ollama pull qwen3:0.6b`. Settings:

```dotenv
OLLAMA_SUPERVISOR_MODEL=qwen3:0.6b
OLLAMA_SUPERVISOR_TIMEOUT_MS=30000
AUTO_MEMORY=true
```

Before each normal response the supervisor chooses whether the main model should
think. `/think` bypasses classification and forces thinking. With a supervisor,
`enable_thinking` is no longer offered to the main model. Routing failures fall
back to non-thinking mode and are logged. Only a bounded portion of the reply
chain is classified; images and large local prompts are not sent to the router.

Group messages also enter bounded per-room buffers, even without mentioning the
bot. After a five-second batch delay, the supervisor extracts at most one explicit,
stable, high-confidence fact; validated results go into that group's usual memory
file. It cannot change owner facts or personality. Private messages and bot
messages are excluded. Telegram must actually receive group messages for this to
work; privacy mode/permissions still apply. Set `AUTO_MEMORY=false` to disable it.

Background extraction and normal responses share the same inference queue, with
background jobs at lower priority; model calls do not overlap. Each extraction
reads at most four recent buffered statements, with truncation, and uses a 4096
context window (routing uses 2048). Pending buffers are bounded and may discard
old messages under load. The extractor is instructed to reject sensitive data,
commands, questions, quotes and insults; additional code checks reject uncertain,
unattributed or obvious contact/secret-like output. Semantic extraction remains
model-dependent and is not a perfect filter. Changes are silent in chats; accepted
facts are logged by count and saved with source-author attribution.

## Occasional spontaneous replies

The supervisor may propose a short humorous or interesting contribution to an
unaddressed group message. It does not intervene in private chats, commands, or
replies between other participants. Explicit mentions and replies to the bot still
work normally. Discord spontaneous replies stay in the existing channel instead of
creating a thread. Settings:

```dotenv
SPONTANEOUS_REPLIES=true
SPONTANEOUS_CHANCE=0.05
SPONTANEOUS_COOLDOWN_MS=300000
```

The chance controls sampling for evaluation, not guaranteed responses. Eligible
messages are evaluated at most once per room per 30 seconds, with only one global
spontaneous decision pending. The model must provide a concrete angle and confidence
of at least 0.95. Successful decisions impose a five-minute room cooldown. Decisions
older than one minute are discarded. Classification runs at low priority in the
shared inference queue, and failure means silence. The prompt requests a single
short, non-aggressive contribution. Disabling `SPONTANEOUS_REPLIES` restores only
explicit triggering (including the pre-existing bot-owned Discord thread behavior).

## Always-available web tools

Web search/fetch tools are offered by default, including without an Ollama API key.
When configured, Ollama cloud search and fetching are tried first. Missing keys,
errors, empty output or a 12-second primary timeout trigger the fallback: DuckDuckGo
HTML search parsed with Cheerio, and direct public-page text extraction using got.
The existing tool loop still preloads the first two search results.
No command or per-session toggle is needed to enable search.

Fallback downloads have a 12-second timeout, a 2 MB decoded-body limit and at most
three redirects. URL and actual DNS destination checks reject local/private hosts.
DuckDuckGo CAPTCHA or unexpected markup is reported as a tool error, never a fake
result; this is a best-effort scraper and cannot guarantee search uptime. No attempt
is made to bypass challenges.

Automatic memory uses conservative lexical prefiltering for durable rules,
schedules and project statements. A batch can save at most one fact with confidence
at least 0.99 and an allowed category. Saved text must be a verbatim substring of
the actual source supplied to the model; invented dates, extra conclusions and
paraphrases are rejected. Casual reactions without durable-fact cues are not sent
to the extractor. These checks reduce false memories at the cost of missing some
useful facts; explicit memory tools remain available for intentional requests.

Automatic memory is rate-limited per group across all its rooms/topics:
`AUTO_MEMORY_CHECK_INTERVAL_MS=60000` limits background checks to once per minute,
and `AUTO_MEMORY_COOLDOWN_MS=120000` allows at most one automatic save attempt every
2 minutes after an accepted candidate. Messages arriving during either pause
are discarded from auto-memory buffers rather than saved later. Main-model
`remember` instructions now require an explicit user request; intentional memory
operations bypass the automatic cooldown. Limits reset on process restart.

## Image replies

Adapters expose `search_images` and `send_image`. Image search uses DuckDuckGo
through the `duck-duck-scrape` library, with Bing Images as a fallback when
DuckDuckGo fails or returns no results. Both support photos, illustrations and memes.
Bing results use hosted previews to avoid hotlink blocking by source websites;
the source-page link remains available in tool metadata.
The model selects a returned id to send one image per session. Telegram sends a
photo; Discord sends an image embed. Media messages have no captions, titles,
footers or source links. Author and license information are not supplied or inferred. Invalid and non-public URLs
are filtered, duplicate images removed, and at most five candidates returned.
Model-supplied arbitrary image URLs are rejected; candidates belong only to the
current session. The model sees search metadata, not downloaded pixels.
Search can be used on explicit requests or occasionally when a picture suits the
answer. Search providers may rate-limit or block automated searches; failures are
reported to the model as tool errors.

## GIF replies

Set `KLIPY_API_KEY` in `.env` to enable `search_gifs` and `send_gif`, then restart.
Get a key from [KLIPY](https://partner.klipy.com). Without a key GIF tools are hidden;
ordinary image search remains available. The provider uses the
[Tenor-compatible KLIPY API](https://docs.klipy.com/migrate-from-tenor).
Telegram sends animations via `sendAnimation`; Discord embeds the animated GIF.
Source/provider metadata stays in tool results; outgoing media has no caption.
Images and GIFs share a one-send-attempt limit per request. The model sees
metadata, not animation frames. The model may finish with an empty text response
after successful delivery: adapters delete temporary text/status messages so
only the image or GIF remains. Delivery and generation failures still show errors.

Bun runs TypeScript directly; no build step is required. Use `bun run dev` for watch mode. Application and test type checking is configured in `tsconfig.json`. Tests use typed partial doubles at external API boundaries. Commit `bun.lock` when dependencies change and use `bun install --frozen-lockfile` for reproducible installs.
