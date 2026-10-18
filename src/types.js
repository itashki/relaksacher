/**
 * Shared contracts for the platform-independent assistant and its adapters.
 * This module contains documentation types only and has no runtime behavior.
 * @module types
 */

/** @typedef {import("ollama").Message} ChatMessage */
/** @typedef {import("ollama").Tool} ToolDefinition */
/** @typedef {import("ollama").ToolCall} ToolCall */

/**
 * @typedef {object} RequestContext
 * @property {string} [scopeId] Storage namespace; absent when memory is disabled.
 * @property {string} [authorName] Display name used for memory attribution and logs.
 * @property {function(ImageCandidate): Promise<void>} [sendImage] Deliver a searched image to the current chat.
 * @property {{candidates: Map<string, ImageCandidate>, sent: boolean, attempted?: boolean}} [imageState] Per-session image selection state.
 * @property {function(number): Promise<{source: string, messages: BackgroundMessage[], limited?: boolean, note?: string}>} [readHistory] Scoped history capability; no arbitrary chat ids.
 */

/**
 * @typedef {object} BackgroundMessage
 * @property {string} id Platform message identifier.
 * @property {string} author Human-readable author description.
 * @property {string} content Message text.
 * @property {boolean} [isAssistant] Whether the author is this bot.
 * @property {string|null} [replyTo] Referenced message identifier.
 */

/**
 * @typedef {object} MemoryFact
 * @property {number} id Scope-local fact identifier.
 * @property {string} fact Stored statement.
 * @property {string} [by] Author who added the statement.
 * @property {string} [at] ISO timestamp of creation.
 */

/**
 * @typedef {object} GenerationUpdate
 * @property {string} text Accumulated answer, excluding platform formatting.
 * @property {ToolCall|""} status Active tool call or an empty string.
 * @property {boolean} final Whether this is the last update.
 * @property {string} [modelAlias] Optional public model signature.
 */

/**
 * @typedef {object} GenerationResult
 * @property {string} text Final answer with any interruption marker.
 * @property {string} thinkingLog Accumulated reasoning, intended for server logs.
 * @property {string} model Actual Ollama model identifier.
 * @property {string} [modelAlias] Optional public model signature.
 * @property {string|null} incompleteReason Detected truncation reason, if any.
 * @property {boolean} failed Whether generation encountered an error.
 * @property {boolean} stopped Whether cancellation was requested.
 * @property {boolean} timedOut Whether the generation deadline expired.
 */

/**
 * @typedef {object} SessionOptions
 * @property {ChatMessage[]} conversation Reply chain ending in the current request.
 * @property {BackgroundMessage[]} [background] Optional ambient context; adapters leave it empty.
 * @property {RequestContext} [context] Request attribution and memory scope.
 * @property {boolean} [think] Enable thinking from the first model round.
 * @property {string} [assistantName] Platform-specific bot name.
 * @property {string} [platformInstructions] Platform-specific prompt instructions.
 * @property {function(GenerationUpdate): (void|Promise<void>)} [onUpdate] Awaited delivery callback.
 * @property {function(number): (void|Promise<void>)} [onQueued] Initial waiting position callback.
 */

/**
 * @typedef {object} Session
 * @property {function(): void} stop Cancel generation or mark a waiting request stopped.
 * @property {function(): Promise<GenerationResult>} run Run once through the shared queue.
 */

/**
 * @typedef {object} Assistant
 * @property {function(function(object): void): function(): void} subscribeTerminal Observe local request, queue, answer and reasoning snapshots; returns unsubscribe.
 * @property {function(): boolean} stopCurrentGeneration Cancel the running reply; queued requests remain queued.
 * @property {function(SessionOptions): Session} createSession Create an unstarted request.
 * @property {function({scopeId: string, roomId: string, id: string, text: string, authorName: string}): void} observeMessage Buffer an ordinary group statement.
 * @property {function(object): Promise<{angle: string}|null>} considerMessage Occasionally classify a group message for spontaneous intervention.
 * @property {function(): Promise<void>} flushObservations Process one buffered room batch.
 * @property {function(): void} stopObserving Cancel background inference and discard buffers.
 */

/** @typedef {ReturnType<import("./core/memory.js").createMemoryStore>} MemoryStore */
/** @typedef {ReturnType<import("./core/tools.js").createToolService>} ToolService */

/**
 * @typedef {object} AssistantOptions
 * @property {Pick<import("ollama").Ollama, "chat">} modelClient Streaming model client.
 * @property {MemoryStore} memory Persistent fact storage.
 * @property {ToolService} toolService Tool definitions and execution.
 * @property {string} model Fixed main model identifier.
 * @property {number} numCtx Default context window size.
 * @property {number} timeoutMs Generation deadline, excluding queue waiting.
 * @property {number} [updateIntervalMs] Minimum interval between ordinary text updates.
 * @property {string[]} [facts] Owner-provided facts.
 * @property {string} [personality] Local personality instructions.
 * @property {ReturnType<import("./core/supervisor.js").createSupervisor>} [supervisor] Small routing/extraction model.
 * @property {{enabled?: boolean, chance?: number, cooldownMs?: number}} [spontaneous] Unsolicited group reply policy.
 * @property {boolean} [autoMemory] Whether to extract facts from ordinary group messages.
 * @property {number} [autoMemoryCooldownMs] Minimum interval between automatic saves per group.
 * @property {number} [autoMemoryCheckIntervalMs] Minimum interval between background checks per group.
 * @property {Pick<Console, "info">} [logger] Destination for reasoning logs.
 */

/**
 * @typedef {object} AppConfig
 * @property {string|undefined} token Discord bot token.
 * @property {string|undefined} telegramToken Telegram bot token.
 * @property {number} telegramTimeoutMs Telegram API request timeout.
 * @property {number} telegramUpdateIntervalMs Telegram rendering interval.
 * @property {string[]} adapters Enabled adapters.
 * @property {string|undefined} applicantId Discord application identifier.
 * @property {string|undefined} publicKey Discord application public key.
 * @property {string} OLLAMA_URL Ollama server address.
 * @property {string} OLLAMA_MODEL Fixed main model identifier.
 * @property {number} OLLAMA_TIMEOUT Generation timeout in milliseconds.
 * @property {string|null} gifApiKey Optional KLIPY GIF search credential.
 * @property {string|null} OLLAMA_API_KEY Optional cloud search credential.
 * @property {number} OLLAMA_NUM_CTX Default context window size.
 * @property {string} supervisorModel Small routing/extraction model identifier.
 * @property {number} supervisorTimeoutMs Auxiliary model deadline.
 * @property {boolean} autoMemory Whether background extraction is enabled.
 * @property {number} autoMemoryCooldownMs Minimum automatic save interval.
 * @property {number} autoMemoryCheckIntervalMs Minimum background check interval.
 * @property {{enabled: boolean, chance: number, cooldownMs: number}} spontaneous Unsolicited group reply policy.
 * @property {string[]} facts Owner-provided facts.
 * @property {string} personality Active personality instructions.
 */

/**
 * @typedef {function(string, Object<string, *>=, AbortSignal=): Promise<*>} TelegramRequest
 */
/**
 * @typedef {TelegramRequest & {downloadImage: function(string): Promise<string>}} TelegramApi
 */
/**
 * @typedef {object} TelegramBot
 * @property {function(import("@grammyjs/types").Update): Promise<void>} handleUpdate Handle an incoming update.
 * @property {function(): Promise<void>} start Start polling; resolves when polling stops.
 * @property {function(): (Promise<void>|undefined)} stop Stop polling and active sessions.
 */

/**
 * @typedef {object} ImageCandidate
 * @property {"gif"} [kind] Animated GIF candidate; omitted for static images.
 * @property {string} [provider] Media provider attribution.
 * @property {string} title Search result title.
 * @property {string} url Public image URL.
 * @property {string} sourceUrl Original source page.
 * @property {string} [author] Image attribution.
 * @property {string} [license] License label.
 */

export {};
