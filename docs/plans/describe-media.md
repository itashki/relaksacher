# Describe media: !describe, SmolVLM2 video descriptions, video-note auto-description and a model tool

Goal: Add a `!describe` / `!опиши` command for Telegram and Discord. It describes an attached or replied-to image through the existing Ollama vision path, and a video through a new local SmolVLM2 server. Telegram video notes (circles, `message.video_note`) are described automatically; regular `video` messages are not. Stored video descriptions reach the chat model through a new `read_video_descriptions` tool, so it can "look at" videos it cannot see.
Decisions:

- Image path (no new dependency): `!describe` on an image makes a direct, neutral one-shot call to `OLLAMA_VISION_MODEL ?? OLLAMA_MODEL`. It has no persona, tools or history. The call still goes through the assistant's shared FIFO queue (`core/queue.ts`), so it never runs on the GPU at the same time as a reply. A small `assistant.runExclusive(task)` exposes that queue. The call uses `stream: true` and `stream.abort()` on timeout because `Ollama.abort()` would cancel every request on the client. If the model rejects images, the bot replies "Модель не поддерживает изображения; задайте OLLAMA_VISION_MODEL."
- Video path (new runtime): SmolVLM2 has no Ollama or whisper.cpp equivalent, so the plan copies the existing GigaAM pattern. That means a resident Python loopback server, `scripts/smolvlm-server.py` on `127.0.0.1:8083`, managed by `createLocalSpeechServer` (generic despite the name; the plan reuses it unchanged and does not rename it). It runs on Hugging Face `transformers` + torch, with frames sampled by `ffmpeg`/`ffprobe`, which are already on PATH in the package and the dev shell. Frames are passed to the model as an ordered list of images with timestamps instead of `{"type":"video"}`. This avoids a decord/PyAV dependency. The builder confirms the message format against the pinned transformers version. torch and transformers are imported lazily so the server's contract test runs with plain `python3`. The server sets `HF_HUB_OFFLINE=1` and loads weights with `local_files_only=True`, so it never downloads at runtime.
- Nix: the Torch `torch-bin` cu130 override moves out of `nix/gigaam.nix` into a shared `nix/torch-python.nix`. The RTX 5070 is Blackwell, stock nixpkgs torch may not support it, and sharing avoids a second multi-GB torch. A new `nix/smolvlm.nix` builds `python.withPackages` with `transformers`, `pillow`, `num2words` and `accelerate`. It avoids torchvision unless the slow image processor (`use_fast=False`) fails. Weights are pinned per file (`resolve/<commit>/<file>` + sha256) in `nix/models.nix` and linked into a directory by a new `nix/smolvlm-models.nix` (`linkFarm`, the same as `gigaam-models.nix`). CI never evaluates Nix, so the Nix step's `Done when` performs a real build and a real model smoke run.
- Configuration (all optional, read in `src/config.ts`):
  - `SMOLVLM_AUTO_START` (default `true`)
  - `SMOLVLM_URL` (default `http://127.0.0.1:8083/describe`)
  - `SMOLVLM_PYTHON` (default `python3`)
  - `SMOLVLM_MODEL_DIR` (default `models/smolvlm2`)
  - `SMOLVLM_DEVICE` (`auto|cuda|cpu`, default `auto`)
  - `SMOLVLM_TIMEOUT_MS` (default `300000`)
  - `SMOLVLM_MAX_FRAMES` (default `8`)
  - `VIDEO_NOTE_DESCRIPTION` (`off|silent|reply`, default `silent`)
- Graceful skip: the SmolVLM server starts in `index.ts` in parallel and is not on the `speech.start().then(transports.start)` critical path. A start failure logs one warning and marks video description unavailable. It never shuts the app down. When unavailable, `!describe` on a video replies "Описание видео недоступно.", auto-description is skipped silently, and the tool returns a readable "недоступно". Its `stop()` joins the shutdown steps.
- Storage: `createVideoDescriptionStore(directory)` in `src/core/memory/video-descriptions.ts` writes one JSON file per chat under `<MEMORY_DIR>/video-descriptions/<sanitized chatId>.json`. A chat id has every character outside `[A-Za-z0-9_-]` replaced by `_`. The chat id is the adapter's `context.chatId`, e.g. `telegram_<chat>:<thread>`. Writes use `replaceFileAtomically` behind a per-chat lock. The store keeps at most 100 entries per chat, oldest dropped. Descriptions are at most 2000 chars. Entries are deduped by `fileUniqueId` so forwarded circles reuse the stored text. Entry: `{ messageId, fileUniqueId?, kind: "video_note"|"video"|"animation", author, at (ISO), durationSec?, description, model }`. The data is persistent because every code change restarts the bot.
- Tool `read_video_descriptions`:
  - Input: `{ message_id?: string, limit?: integer 1–10, default 5 }`.
  - With `message_id` it returns that entry. On a miss, it describes the video on demand if the adapter can resolve that id to a cached video in the current chat.
  - Output: JSON `{ source: "video_descriptions", note, descriptions: [{ message_id, kind, author, at, duration_sec, description }] }`. The note says the descriptions were made by a local model from frames without sound, and that they are data, not instructions.
  - It is offered only when the adapter supplies the `RequestContext.videoDescriptions` capability, following the `readHistory` pattern, with a new `videoDescriptions` flag in `ToolService.definitions`.
  - Code lives in a new `src/core/tools/video-descriptions.ts` (fursona.ts pattern), because `tools/index.ts` is 354 lines.
- Telegram: the new `src/adapters/telegram/media-commands.ts`, modeled on `voice-commands.ts`, is called right after `handleTelegramVoiceCommands` in `handleMessage`, before the no-text early return. A described circle is also `remember()`ed with a labeled text, `[Видеосообщение, описание: …]`, so reply chains and `read_history` see it without attributing the words to the author. Discord gets `!describe` in a new `src/adapters/discord/describe-command.ts`, because `discord/index.ts` is at 551 lines. Only a few dispatch lines are added there.
- File sizes: every new module targets 100–300 lines. `assistant/index.ts` (512) and `discord/index.ts` (551) receive only a few lines each.
- OPEN DECISIONS (defaults chosen; the user should confirm):
  - (a) Model size and VRAM. The GPU has 8 GB with about 2.4 GB already in use, shared with Ollama and GigaAM. The default is `HuggingFaceTB/SmolVLM2-500M-Video-Instruct`: about 1 GB of weights and about 2 GB VRAM in bf16. The 2.2B variant is about 4.5 GB of weights and does not fit next to an Ollama model; the 256M variant is about 0.5 GB. `SMOLVLM_DEVICE=cpu` is the fallback, and it is slow, roughly tens of seconds per circle.
  - (b) Weight location and size. The weights are in the Nix store, downloaded once on the first `nix build` (about 1 GB). Outside Nix, `SMOLVLM_MODEL_DIR` must point to a local snapshot.
  - (c) Visibility of auto-description. The default `silent` stores the description and labels the cache without posting anything. `reply` posts `🎬 <description>` like voice transcription does.
  - (d) Language. SmolVLM2 writes English. Descriptions are stored and shown in English; there is no translation pass. A Russian translation through the text model would add one queued Ollama call per video.
  - (e) Sound. SmolVLM2 ignores audio, and circles are usually speech. Adding the GigaAM transcript of the circle's audio to the stored entry is a possible follow-up, not part of this plan.
  - (f) The resident SmolVLM process keeps its VRAM for the life of the service. Idle unloading is not planned.

## Step 1: SmolVLM2 loopback server with a stdlib-only contract test

Files: scripts/smolvlm-server.py, test/media/smolvlm_server_test.py
Do:

- Create `scripts/smolvlm-server.py` and mirror the structure of `scripts/gigaam-server.py`: a module docstring, `argparse`, `HTTPServer`, a `BaseHTTPRequestHandler` built by `handler_for(...)`, and a 60 s socket timeout.
- CLI flags:
  - `--host 127.0.0.1`
  - `--port 8083`
  - `--model DIR` (required)
  - `--device auto|cuda|cpu`
  - `--max-frames 8`
  - `--describe-file PATH`: an operator smoke mode that loads the model, prints one description to stdout and exits 0.
- Before any HF import, set `os.environ.setdefault("HF_HUB_OFFLINE", "1")` and `TRANSFORMERS_OFFLINE=1`.
- Functions, each with a docstring stating its contract:
  - `probe_duration(path)` uses `ffprobe` and returns float seconds; it raises `ValueError` for non-video input.
  - `sample_frames(path, max_frames, out_dir)` uses `ffmpeg` to extract up to `max_frames` evenly spaced frames scaled to at most 384 px on the long side. It returns `[(timestamp_seconds, png_path)]`, ordered, at least 1.
  - `load_model(model_dir, device)` lazily imports torch and transformers and returns a bundle with `AutoProcessor` and `AutoModelForImageTextToText`. It uses bf16 on CUDA and float32 on CPU, `local_files_only=True`, and resolves `auto` to cuda when available.
  - `describe_frames(bundle, frames, prompt)` builds one user message from the frames as ordered images, each preceded by `Frame N at T s`, followed by the prompt. The default prompt is in English: "Describe this short video in detail: people, actions, setting, visible text. Do not guess sounds or speech." It runs `generate(max_new_tokens=256, do_sample=False)` under `torch.inference_mode()` and returns stripped text.
- HTTP API:
  - `GET /health` returns `{"status":"ok","backend":"smolvlm","device":...}`.
  - `POST /describe` takes multipart `file` (at most 20 MiB; reject larger with 413 before reading) and an optional `prompt` (at most 1000 chars). It returns `{"description": str, "frames": int, "duration": float}`.
  - 400 means invalid or undecodable video or an empty result; 404 means any other path; 500 means an inference failure. Every error body is JSON `{"error": ...}`.
  - Temporary files go in `tempfile.TemporaryDirectory()`, so they are cleaned up on every path.
  - Make `handler_for(describe, device)` take a callable `describe(video_path, prompt) -> dict` so tests can inject a fake.
- Write `test/media/smolvlm_server_test.py` with `unittest`, loading the script via `importlib.util.spec_from_file_location` like `test/speech/gigaam_server_test.py`. It must import nothing beyond the stdlib.
  - Generate a 3 s `testsrc` MP4 with `ffmpeg` in a temp dir.
  - Test that `sample_frames` returns at most `max_frames` ordered timestamps.
  - Test that `/health` returns ok.
  - Test that `/describe` with a fake describe returns 200 JSON.
  - Test that a non-video upload gets 400, an oversize `Content-Length` gets 413, and an unknown path gets 404.
- Start the docstring with "Run with: python3 test/media/smolvlm_server_test.py".

Done when: `python3 -I test/media/smolvlm_server_test.py && bun run lint && bun run format:check && bun test`
Status: done

## Step 2: Nix packaging of the SmolVLM2 runtime and pinned weights

Files: nix/torch-python.nix, nix/gigaam.nix, nix/smolvlm.nix, nix/models.nix, nix/smolvlm-models.nix, nix/package.nix, nix/dev-shell.nix, .github/workflows/build.yml, scripts/smolvlm-server.py, test/media/smolvlm_server_test.py
Do:

- Move the `python313.override { packageOverrides = ... torch-bin cu130 ... }` block from `nix/gigaam.nix` into `nix/torch-python.nix`, which takes `{ pkgs }` and returns `python`. `gigaam.nix` then imports it, and GigaAM must evaluate to the same torch store path as before.
- Create `nix/smolvlm.nix` as `python.withPackages (ps: [ ps.transformers ps.pillow ps.num2words ps.accelerate ])`, using the shared python.
- In `nix/models.nix`, add one `fetchurl` per file of `HuggingFaceTB/SmolVLM2-500M-Video-Instruct` at a fixed commit. Get the commit and file list from `https://huggingface.co/api/models/HuggingFaceTB/SmolVLM2-500M-Video-Instruct`; it is the config, generation config, `model.safetensors`, processor, preprocessor, chat template, tokenizer and special-token files. Compute real hashes with `nix store prefetch-file`. Never commit placeholder hashes.
- Create `nix/smolvlm-models.nix` as a `linkFarm "smolvlm2-500m-video"` of those files under their original names.
- In `nix/package.nix`, add `--set-default SMOLVLM_PYTHON ${smolvlmPython}/bin/python3` and `--set-default SMOLVLM_MODEL_DIR ${smolvlmModels}`. `ffmpeg` is already on the wrapper PATH.
- In `nix/dev-shell.nix`, add the same two variables.
- In `.github/workflows/build.yml`, add `scripts/smolvlm-server.py` to the tarball beside `scripts/silero-tts.py`.
- This is the first run against the real model. If the smoke run fails, fix the server's model loading or message handling in `scripts/smolvlm-server.py`: the processor's frame/message format, `use_fast`, chat-template shape or dtype. Keep the Step 1 test green.

Done when: `nix eval --raw path:.#packages.x86_64-linux.default.drvPath && nix build --no-link path:.#packages.x86_64-linux.default && nix develop path:. --command bash -c 'd=$(mktemp -d) && ffmpeg -loglevel error -f lavfi -i testsrc=duration=3:size=384x384:rate=10 "$d/c.mp4" && test -n "$("$SMOLVLM_PYTHON" scripts/smolvlm-server.py --model "$SMOLVLM_MODEL_DIR" --device auto --describe-file "$d/c.mp4")"' && bun run lint && bun run format:check && bun test`
Status: done

## Step 3: Configuration, server lifecycle and the queued video client

Files: src/config.ts, src/types.ts, .env.example, src/core/media/smolvlm-server.ts, src/core/media/video-description.ts, index.ts, test/media/video-description.test.ts, test/media/smolvlm-server.test.ts, docs/ARCHITECTURE.md
Do:

- In `src/config.ts`, parse and validate the `SMOLVLM_*` and `VIDEO_NOTE_DESCRIPTION` variables from Decisions:
  - booleans use `!== "false"`
  - the device and mode values come from enums
  - timeout and max frames must be positive safe integers, with max frames from 1 to 32
  - the URL must be `http:` or `https:`
  - invalid values throw a descriptive `Error`
- Return `config.smolvlm = { python, modelDirectory, device, url, enabled, timeoutMs, maxFrames }` and `config.videoNoteDescription`, and add both to `AppConfig` in `src/types.ts`.
- Document the variables in `.env.example`, commented, next to the GigaAM block.
- Add `src/core/media/smolvlm-server.ts` exporting `createSmolvlmServer(options)`, modeled on `core/speech/gigaam-server.ts`. It wraps `createLocalSpeechServer` with origin `http://127.0.0.1:8083`, label `smolvlm`, a startup timeout of 300000, and the command `[python, "-u", scripts/smolvlm-server.py, "--model", dir, "--device", device, "--max-frames", n]`.
- Add `src/core/media/video-description.ts` exporting `createVideoDescriber({ url, timeoutMs, fetchImpl })`, modeled on `core/speech/transcription.ts`:
  - a `PQueue({concurrency:1})`; reject when 10 or more jobs are waiting
  - the blob is loaded lazily via `load()` when the job starts
  - the blob must be non-empty and at most 20 MiB
  - multipart `file` (`video.mp4`) plus an optional `prompt`
  - `redirect: "error"` and `AbortSignal.timeout`
  - validate that `description` is a non-empty string
  - return `{ description, frames, duration, model: "SmolVLM2" }`
  - also export `available()`/`setAvailable(flag)`: `available()` starts `false` and becomes `true` only after the server's `start()` resolves, because startup can take up to 5 minutes; callers skip work while it is false
  - document the contract in JSDoc
- In `index.ts`, construct `createSmolvlmServer(config.smolvlm)` when `config.smolvlm.enabled`. Call `.start()` without awaiting it in the transports chain:
  - on resolve, call `setAvailable(true)`; on rejection, call `console.warn("[smolvlm] unavailable:", ...)` and leave it unavailable
  - when `SMOLVLM_AUTO_START=false`, or the URL is not the managed origin, treat the endpoint as externally managed: probe `/health` once at startup and set availability from the result
  - add `() => smolvlm?.stop()` to the shutdown steps
  - pass the describer into `createApplication` through a new optional parameter, which this step only stores
- Tests use an injected fetch and spawn, with no network or Python:
  - the client happy path
  - empty, oversized, non-OK, and non-JSON/empty description responses
  - queue overflow
  - lazy load only when the job runs
  - `createSmolvlmServer` builds the expected command and origin
  - in `test/media/smolvlm-server.test.ts`, test `loadConfig` the way `test/speech/gigaam-server.test.ts` does, with valid and invalid `SMOLVLM_DEVICE` and `VIDEO_NOTE_DESCRIPTION`
  - availability is false before start resolves and true after
- Add `docs/ARCHITECTURE.md` rows ("Адаптеры" or a new table under `## Описание видео`) for `core/media/smolvlm-server.ts` and `core/media/video-description.ts`.

Done when: `bun run lint && bun run typecheck && bun run format:check && bun test test/media && bun test`
Status: done

## Step 4: Image describer through the shared queue and the media-description facade

Files: src/core/assistant/index.ts, src/types.ts, src/core/media/image-description.ts, src/core/media/index.ts, src/runtime/application.ts, test/media/image-description.test.ts, test/core/runtime-application.test.ts, docs/ARCHITECTURE.md
Do:

- In `src/core/assistant/index.ts`, expose `runExclusive<T>(task: () => Promise<T>): Promise<T>`, which delegates to the existing `enqueue` at normal priority. Add it to the `Assistant` type with a JSDoc contract. Keep this to a few lines; the file is at 512.
- Add `src/core/media/image-description.ts` exporting `createImageDescriber({ modelClient, model, timeoutMs, runExclusive })`. It returns `describeImage(base64, question?)`, which, inside `runExclusive`:
  - streams `modelClient.chat({ model, stream: true, messages: [system: neutral describer in Russian, user: question || "Подробно опиши изображение." with images: [base64]] })`, with no tools
  - accumulates `message.content`, calling `stream.abort()` on timeout
  - applies `think: false` when `requiresNonThinking(model)` from `core/assistant/models.ts`
  - maps an Ollama error that mentions images or vision to `Error("Модель не поддерживает изображения; задайте OLLAMA_VISION_MODEL.")`
  - returns trimmed text and rejects on empty output
- Add `src/core/media/index.ts` exporting `type MediaDescriber = { describeImage(base64, question?): Promise<string>; describeVideo(load: () => Promise<Blob>, prompt?): Promise<VideoDescriptionResult>; videoAvailable(): boolean }` and a `createMediaDescriber({ image, video })` that composes them. When video is unavailable, `describeVideo` rejects with "Описание видео недоступно.".
- In `src/runtime/application.ts`, build the facade with `config.OLLAMA_VISION_MODEL ?? config.OLLAMA_MODEL`, `config.OLLAMA_TIMEOUT`, `assistant.runExclusive` and the video describer from Step 3. Expose it as `application.describer`. Do not pass it to adapters yet.
- Tests use a fake modelClient stream:
  - the prompt contains the image and no tools
  - the call runs through the queue, ordered after an earlier queued task
  - a timeout aborts the stream
  - an unsupported-vision error is mapped
  - empty output rejects
  - extend the runtime-application test to assert that `describer` exists
- Add `docs/ARCHITECTURE.md` rows for `core/media/image-description.ts` and `core/media/index.ts`. State that `describeImage` uses the shared queue and must never be called from inside a running session or tool, because the queue has concurrency 1 and it would deadlock.

Done when: `bun run lint && bun run typecheck && bun run format:check && bun test test/media test/core/runtime-application.test.ts && bun test`
Status: done

## Step 5: Persistent per-chat video-description store

Files: src/core/memory/video-descriptions.ts, src/types.ts, src/runtime/application.ts, test/core/video-descriptions.test.ts, docs/ARCHITECTURE.md
Do:

- Implement `createVideoDescriptionStore(directory)` per Decisions, with each method documented:
  - `save(chatId, entry)` upserts by `messageId`, truncates the description to 2000 chars, keeps the newest 100, and returns the saved entry
  - `get(chatId, messageId)` returns the entry or null
  - `findByFile(chatId, fileUniqueId)` returns the entry or null
  - `list(chatId, limit)` returns the newest entries first
- Writes go through `replaceFileAtomically(file, json, { createPath: true })` behind a `Map<chatId, Promise>` lock, like `core/memory/index.ts`. A missing file or invalid JSON reads as empty, and a parse error is logged once.
- Export `type VideoDescription` from the module and reference it in `src/types.ts`.
- Construct the store in `application.ts` at `resolvePath("video-descriptions", memoryDirectory)` and expose it as `application.videoDescriptions`.
- Tests use `test/support/temp.ts`:
  - a round trip
  - an upsert
  - the 100-entry bound
  - dedupe lookup by `fileUniqueId`
  - unsafe chat id characters stay inside the directory
  - concurrent saves keep all entries
  - a corrupt file reads as empty
- Add an `docs/ARCHITECTURE.md` row for `core/memory/video-descriptions.ts`.

Done when: `bun run lint && bun run typecheck && bun run format:check && bun test test/core/video-descriptions.test.ts && bun test`
Status: done

## Step 6: Telegram `!describe` command and video download

Files: src/adapters/shared/video.ts, src/adapters/telegram/api.ts, src/types.ts, src/adapters/telegram/media-commands.ts, src/adapters/telegram/index.ts, src/runtime/application.ts, test/support/telegram-fixture.ts, test/telegram/telegram-describe.test.ts, test/core/images.test.ts, docs/COMMANDS.md, docs/ARCHITECTURE.md
Do:

- Add `src/adapters/shared/video.ts` with `downloadVideo(url, { allowedHosts, fetchImpl })`, copied from `adapters/speech/voice.ts`: HTTPS only, the host allowlist, no credentials, `redirect: "error"`, a 60 s timeout, and at most 20 MiB streamed. It checks the MP4/MOV `ftyp` box at bytes 4–8 and returns `Blob` type `video/mp4`. Errors are sanitized.
- In `api.ts`, add `request.downloadVideo(fileId)`, mirroring `downloadVoice`, with the `getFile` size and path checks. Add `downloadVideo?` to `TelegramApi`.
- Create `media-commands.ts` exporting `handleTelegramMediaCommands(message, deps): Promise<boolean>`. Deps are `{ api, me, describer?, store?, chatId(message), remember }`.
- The command matches `/^!(?:describe|опиши)(?:@(\w+))?(?:\s+([\s\S]*))?$/iu` on `text ?? caption`. Ignore it, returning true, when it is addressed to another bot.
- The target is the message itself if it carries media, otherwise `reply_to_message`:
  - an image (`imageFiles`) goes to `describer.describeImage(await api.downloadImage(id), question)`
  - `video_note`, `video`, `animation`, or a `document` with `video/mp4` goes to `describer.describeVideo(() => api.downloadVideo(id), question)`
  - before describing a video, check `store.findByFile(chatId, file_unique_id)`
  - after describing, `store.save` it with kind, author, duration and model, and `remember()` the target with the labeled text
- Reply via `sendMessage` chunks (`splitText`), `🖼 ` or `🎬 ` prefix, preserving the forum thread and `reply_parameters` like `voice-commands.ts`.
- Usage and error replies:
  - "Используйте !describe ответом на изображение или видео." when there is no media
  - "Описание видео недоступно." when unavailable
  - a sanitized failure message
- In `index.ts`, add `describer` and `videoDescriptions` options to `createTelegramBot`, and call the handler right after `handleTelegramVoiceCommands`.
- In `application.ts`, pass both to `createTelegramBot`.
- Make the fixture accept optional `describer`, `videoDescriptions` and `api.downloadVideo` overrides.
- Tests:
  - downloadVideo rejects wrong hosts, oversize bodies and non-ftyp bodies
  - `!describe` replying to a photo calls describeImage and replies in the thread
  - replying to a video calls describeVideo, stores the entry and replies
  - a repeat on the same `file_unique_id` reuses the store without calling describeVideo
  - `!describe@otherbot` is ignored
  - no media gives the usage reply
  - unavailable video gives the unavailable reply
  - no session is created for `!describe`
- Docs, in Russian and in the existing style:
  - in `docs/COMMANDS.md`, add `## Описание изображений и видео` after "Ручная расшифровка голосовых"
  - cover `!describe` / `!опиши` with an optional question, sent as a reply or with an attachment, and `@имя_бота` in groups
  - images go to `OLLAMA_VISION_MODEL`; videos go to SmolVLM2 (frames only, no sound, English output)
  - limits are 20 MB and at most 10 queued jobs; describe the "unavailable" reply
  - say it is Telegram-only for now
  - add `docs/ARCHITECTURE.md` rows for `adapters/telegram/media-commands.ts` and `adapters/shared/video.ts`

Done when: `bun run lint && bun run typecheck && bun run format:check && bun test test/telegram test/core/images.test.ts && bun test && grep -q '!describe' docs/COMMANDS.md`
Status: done

## Step 7: Automatic description of Telegram video notes only

Files: src/adapters/telegram/media-commands.ts, src/adapters/telegram/index.ts, test/telegram/telegram-describe.test.ts, docs/COMMANDS.md
Do:

- In `handleTelegramMediaCommands`, when there is no command, the message has `video_note`, the sender is not a bot, `config.videoNoteDescription !== "off"`, and `describer?.videoAvailable()` is true:
  - describe the circle, deduping via `findByFile`, with kind `video_note` and `durationSec: video_note.duration`
  - `store.save` it
  - `remember({ ...message, text: "[Видеосообщение, описание: <description>]" })`
  - only in `reply` mode, send `🎬 <description>` as a reply
  - return true
- Failures are logged with `console.warn` and do not reply in `silent` mode. In `reply` mode they reply with a short error.
- Regular `video`, `animation` and video documents without a command fall through unchanged and return false.
- Pass `config` (or just the mode) through the deps.
- `index.ts` batching needs no change, because video notes are already `immediate`. Add a code comment saying so.
- Tests:
  - a `video_note` in silent mode stores the entry, sends no `sendMessage`, and later appears as labeled text in `read_history` output from a subsequent session's `context.readHistory`
  - reply mode sends a reply
  - `off` does nothing
  - a regular `video` message is NOT described: describeVideo is not called
  - an unavailable describer skips silently
  - a bot-sent circle is ignored
- In the `docs/COMMANDS.md` section, document automatic description of video notes only, the `off`/`silent`/`reply` modes of `VIDEO_NOTE_DESCRIPTION`, and that regular videos need the command.

Done when: `bun run lint && bun run typecheck && bun run format:check && bun test test/telegram && bun test && grep -q 'VIDEO_NOTE_DESCRIPTION' docs/COMMANDS.md`
Status: done

## Step 8: `read_video_descriptions` tool and its Telegram capability

Files: src/types.ts, src/core/tools/video-descriptions.ts, src/core/tools/index.ts, src/core/assistant/index.ts, src/adapters/telegram/index.ts, test/tools/video-descriptions.test.ts, test/telegram/telegram-describe.test.ts, docs/COMMANDS.md, docs/ARCHITECTURE.md
Do:

- In `src/types.ts`, add `RequestContext.videoDescriptions?: { list(limit: number): Promise<VideoDescription[]>; get(messageId: string): Promise<VideoDescription | null>; describe?(messageId: string): Promise<VideoDescription | null> }`. Add `videoDescriptions?: boolean` to the `ToolService.definitions` options. Document both.
- Create `src/core/tools/video-descriptions.ts`:
  - export `VIDEO_DESCRIPTIONS_TOOL`, with the schema and Russian description from Decisions
  - export `runVideoDescriptionTool(args, context)`:
    - validate `limit` (1–10, default 5) and `message_id` (a string of at most 32 chars)
    - with `message_id`, use `get`, else `describe` if present, else return "Описание для этого сообщения не найдено."
    - without it, use `list`
    - return JSON `{ source, note, descriptions }` with each description passed through `truncate` to 1500 chars
    - when there are no entries, return "Описаний видео в этом чате нет."
- In `tools/index.ts`, add a branch `if (name === "read_video_descriptions")` that delegates and returns "Описания видео недоступны в этом чате." without the capability. Include the definition when `videoDescriptions` is true.
- In `assistant/index.ts`, near line 272, pass `videoDescriptions: Boolean(context.videoDescriptions)` (one line).
- In the Telegram `createSession` context, supply the capability bound to `chatId = telegram_${roomKey(message)}`:
  - `list` and `get` go to the store
  - `describe(id)` finds the message with that id in `histories.get(roomKey)` or the current reply chain
  - when it carries `video_note`, `video` or `animation`, `describe` runs the same describe-and-store routine exported from `media-commands.ts` and returns null otherwise
  - only offer the capability when `videoDescriptions` is configured
  - on-demand `describe` runs inside a session that holds the shared Ollama queue and spends its `OLLAMA_TIMEOUT`, so cap it at 120 s, separately from `SMOLVLM_TIMEOUT_MS`. On timeout it returns null and the tool reports that the description is not ready yet. It may call only `describeVideo` (the SmolVLM process), never `describeImage` (shared queue deadlock).
- Tests:
  - the definition is present only with the flag
  - list ordering and limit clamping
  - get hit and miss
  - on-demand describe on a miss
  - descriptions are truncated
  - no capability gives the readable message
  - a Telegram session's context exposes `videoDescriptions`, and `get` returns a circle stored in Step 7
  - on-demand describe stops at the 120 s cap (use a fake timer or an injected short cap)
- Docs:
  - in the `docs/COMMANDS.md` section, document the `read_video_descriptions` tool: what the model can read, the per-chat scope, and persistence under `MEMORY_DIR/video-descriptions/`
  - add an `docs/ARCHITECTURE.md` row for `core/tools/video-descriptions.ts`, and a sentence in "Диалоги и инструменты" about the adapter-supplied `videoDescriptions` capability

Done when: `bun run lint && bun run typecheck && bun run format:check && bun test test/tools test/telegram test/assistant && bun test && grep -q 'read_video_descriptions' docs/COMMANDS.md`
Status: done

## Step 9: Discord `!describe`

Files: src/adapters/discord/describe-command.ts, src/adapters/discord/index.ts, src/adapters/discord/message.ts, src/runtime/application.ts, test/discord/discord-describe.test.ts, docs/COMMANDS.md, docs/ARCHITECTURE.md
Do:

- Create `describe-command.ts` exporting `handleDiscordDescribeCommand(message, { describer?, store?, fetchReference }): Promise<boolean>`:
  - it matches `/^!(?:describe|опиши)(?:\s+([\s\S]*))?$/iu`
  - the target is the message's attachments, else the referenced message
  - an image uses the existing `imageFiles` and `downloadImage` with the Discord CDN allowlist already used in `discord/index.ts`
  - a video attachment (`contentType` `video/*`, at most 20 MiB) goes through `shared/video.ts` `downloadVideo` with the same allowlist
  - store video results under `chatId` `discord_<channelId>`, matching what `discord/index.ts` uses for `context.chatId`; check this before choosing the key
  - reply with chunks via `splitMessage`, using the same usage, unavailable and error texts as Telegram
- Add a `videoFiles(message)` helper to `discord/message.ts`.
- In `discord/index.ts`, add only the option plumbing and one early dispatch call next to the `!transcribe` handling, keeping the file at or below 600 lines.
- In `application.ts`, pass `describer` and `videoDescriptions` to `createDiscordBot`.
- Out of scope: no Discord auto-description, because Discord has no video-note type, and no Discord tool capability. Leave a code comment.
- Tests use fixtures from `test/support/fixtures.ts`:
  - image attachment
  - replying to a video
  - no media gives the usage reply
  - unavailable video
  - no session is created
- Docs: in `docs/COMMANDS.md`, change "Telegram-only for now" to Telegram and Discord, and note that Discord has no automatic description. Add an `docs/ARCHITECTURE.md` row for `adapters/discord/describe-command.ts`.

Done when: `bun run lint && bun run typecheck && bun run format:check && bun test test/discord && bun test && test $(wc -l < src/adapters/discord/index.ts) -le 600`
Status: done

## Step 10: Operator and developer documentation

Files: docs/ARCHITECTURE.md, docs/DEVELOPMENT.md, README.md
Do:

- Write in Russian, matching the existing style. Per-feature command docs and module rows were already added in Steps 3–9; this step covers runtime setup.
- `docs/ARCHITECTURE.md`: add a short `## Описание видео` section covering:
  - the SmolVLM2 loopback server on port 8083
  - its lifecycle: non-blocking startup, availability only after health, shutdown
  - the single-worker queue
  - the image path through the shared Ollama queue
  - the `video_note`-only auto-description
  - list `transformers` / SmolVLM2 in "Используемые библиотеки"
- `docs/DEVELOPMENT.md`:
  - add `test/media/` to the test groups
  - add `scripts/smolvlm-server.py` to the structure
  - give the Python test command `python3 test/media/smolvlm_server_test.py`
- `README.md`:
  - the `SMOLVLM_*` and `VIDEO_NOTE_DESCRIPTION` variables, with the Nix-provided defaults
  - weight size and location: about 1 GB in the Nix store for the 500M default; outside Nix, a local snapshot in `SMOLVLM_MODEL_DIR`
  - VRAM notes: about 2 GB on an 8 GB GPU shared with Ollama and GigaAM, the `SMOLVLM_DEVICE=cpu` fallback, and the 256M/2.2B alternatives
  - the `--describe-file` smoke command

Done when: `grep -q "SMOLVLM_MODEL_DIR" README.md && grep -q "describe-file" README.md && grep -q "## Описание видео" docs/ARCHITECTURE.md && grep -q "smolvlm_server_test" docs/DEVELOPMENT.md && bun run format:check && bun run lint && bun run typecheck && bun test`
Status: todo
