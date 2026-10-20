/** Shared contracts for the assistant and platform adapters. */
/** Model-compatible conversation entry, including optional image inputs. */
export type ChatMessage = import("ollama").Message;
/** Model tool schema accepted by the Ollama client. */
export type ToolDefinition = import("ollama").Tool;
/** Model-requested tool invocation with parsed arguments. */
export type ToolCall = import("ollama").ToolCall;
/** Adapter-scoped capabilities; history and media are available only when explicitly supplied. */
export type RequestContext = {
  scopeId?: string;
  authorName?: string;
  sendImage?: (arg0: ImageCandidate) => Promise<void>;
  imageState?: {
    candidates: Map<string, ImageCandidate>;
    sent: boolean;
    attempted?: boolean;
  };
  readHistory?: (arg0: number) => Promise<{
    source: string;
    messages: BackgroundMessage[];
    limited?: boolean;
    note?: string;
  }>;
};
/** Attributed historical message treated as contextual data rather than a new request. */
export type BackgroundMessage = {
  id: string;
  author: string;
  content: string;
  isAssistant?: boolean;
  replyTo?: string | null;
  channelId?: string;
  channelName?: string;
};
/** Persistent scoped fact with a stable identifier and optional author/timestamp attribution. */
export type MemoryFact = {
  id: number;
  fact: string;
  by?: string;
  at?: string;
};
/** Accumulated messenger-visible answer and tool status; private reasoning is excluded. */
export type GenerationUpdate = {
  text: string;
  status: ToolCall | "";
  final: boolean;
  modelAlias?: string;
};
/** Final session outcome; thinkingLog is local-only and must not be sent to chats. */
export type GenerationResult = {
  text: string;
  thinkingLog: string;
  model: string;
  modelAlias?: string;
  incompleteReason: string | null;
  failed: boolean;
  stopped: boolean;
  timedOut: boolean;
};
/** One request and its explicit reply context, platform capabilities and awaited delivery callbacks. */
export type SessionOptions = {
  conversation: ChatMessage[];
  background?: BackgroundMessage[];
  context?: RequestContext;
  think?: boolean;
  assistantName?: string;
  platformInstructions?: string;
  onUpdate?: (arg0: GenerationUpdate) => void | Promise<void>;
  /** Called once before each tool execution, including enable_thinking; excludes tool results. */
  onToolCall?: (call: ToolCall) => void;
  onQueued?: (arg0: number) => void | Promise<void>;
};
/** Single-use generation lifecycle; stop cancels both queued and running sessions. */
export type Session = {
  stop: () => void;
  run: () => Promise<GenerationResult>;
};
/** Platform-neutral session, observation and terminal-monitoring interface. */
export type Assistant = {
  subscribeTerminal: (arg0: (state: TerminalState) => void) => () => void;
  stopCurrentGeneration: () => boolean;
  createSession: (arg0: SessionOptions) => Session;
  observeMessage: (arg0: {
    scopeId?: string;
    roomId: string;
    id: string;
    text: string;
    authorName: string;
  }) => void;
  considerMessage: (arg0: ObservedMessage) => Promise<{
    angle: string;
  } | null>;
  flushObservations: () => Promise<void>;
  stopObserving: () => void;
};
/** Scoped storage operations backed by serialized, atomic JSON updates. */
export type MemoryStore = ReturnType<typeof import("./core/memory/index.ts").createMemoryStore>;
/** Tool definitions and execution; capability flags depend on adapter context and providers. */
export type ToolService = {
  runTool: (call: ToolCall, context: RequestContext) => Promise<string>;
  definitions: (options: {
    scopeId?: string;
    history?: boolean;
    images?: boolean;
  }) => ToolDefinition[];
};
/** Injected model, storage, tools and scheduling settings used to construct the core. */
export type AssistantOptions = {
  modelClient: Pick<import("ollama").Ollama, "chat">;
  memory: MemoryStore;
  toolService: ToolService;
  model: string;
  numCtx: number;
  timeoutMs: number;
  updateIntervalMs?: number;
  facts?: string[];
  personality?: string;
  supervisor?: ReturnType<typeof import("./core/assistant/supervisor.ts").createSupervisor>;
  spontaneous?: {
    enabled?: boolean;
    chance?: number;
    cooldownMs?: number;
  };
  autoMemory?: boolean;
  autoMemoryCooldownMs?: number;
  autoMemoryCheckIntervalMs?: number;
  logger?: Pick<Console, "info">;
};
/** Validated startup configuration shared with enabled platform adapters. */
export type AppConfig = {
  messageBatchWindowMs?: number;
  silero?: import("./adapters/speech/silero.ts").SileroOptions;
  whisperModel?: string;
  whisperAutoStart?: boolean;
  whisperUrl?: string;
  whisperTimeoutMs?: number;
  token: string | undefined;
  telegramToken: string | undefined;
  telegramTimeoutMs: number;
  telegramUpdateIntervalMs: number;
  adapters: string[];
  OLLAMA_URL: string;
  OLLAMA_MODEL: string;
  OLLAMA_TIMEOUT: number;
  gifApiKey: string | null;
  OLLAMA_API_KEY: string | null;
  OLLAMA_NUM_CTX: number;
  supervisorModel: string;
  supervisorTimeoutMs: number;
  autoMemory: boolean;
  autoMemoryCooldownMs: number;
  autoMemoryCheckIntervalMs: number;
  spontaneous: {
    enabled: boolean;
    chance: number;
    cooldownMs: number;
  };
  facts: string[];
  personality: string;
};
/** Compatibility request function around grammY with optional cancellation. */
export type TelegramRequest = (
  arg0: string,
  arg1?:
    | {
        [x: string]: any;
      }
    | undefined,
  arg2?: CancellationSignal,
) => Promise<any>;
/** Telegram request boundary with a trusted-platform image downloader. */
export type TelegramApi = TelegramRequest & {
  downloadImage: (arg0: string) => Promise<string>;
  downloadVoice?: (fileId: string) => Promise<Blob>;
};
/** Search-selected image or GIF metadata; candidate URLs are not arbitrary model input. */
export type ImageCandidate = {
  kind?: "gif";
  provider?: string;
  title: string;
  url: string;
  sourceUrl: string;
  author?: string;
  license?: string;
};
/** Cancellation surface shared by native and grammY signals. */
export type CancellationSignal = Pick<
  AbortSignal,
  "aborted" | "addEventListener" | "removeEventListener"
>;
/** Local operator snapshot for an active, queued or completed generation. */
export type TerminalRequest = {
  id: number;
  text?: string;
  thinking?: string;
  status?: string;
  authorName?: string;
  startedAt?: number;
  [key: string]: unknown;
};
/** Current and last generation plus waiting requests; never exposed as chat history. */
export type TerminalState = {
  current: TerminalRequest | null;
  last?: TerminalRequest | null;
  queue: TerminalRequest[];
};

/** Scoped participant statement eligible for bounded background observation. */
export type ObservedMessage = {
  scopeId?: string;
  roomId: string;
  id?: string;
  text: string;
  authorName: string;
};
/** Abortable incremental model response iterator. */
export type ModelStream = AsyncIterable<import("ollama").ChatResponse> & { abort(): void };
/** Public search hit with extracted text and optional source metadata. */
export type WebSearchResult = { title?: string; url?: string; content: string };
/** Injectable search/fetch provider contract shared by primary and fallback clients. */
export type WebClient = {
  webSearch(request: {
    query: string;
    max_results?: number;
  }): Promise<{ results: WebSearchResult[] }>;
  webFetch(request: {
    url: string;
  }): Promise<{ content: string; title?: string; links?: string[] }>;
};

/** Injectable Web-standard HTTP transport used at network boundaries. */
export type HttpFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

/** Encoded voice message with actual duration and a base64 amplitude preview for Discord. */
export type VoiceRecording = { audio: Blob; duration: number; waveform: string };
