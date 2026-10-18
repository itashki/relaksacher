/** Shared contracts for the assistant and platform adapters. */
export type ChatMessage = import("ollama").Message;
export type ToolDefinition = import("ollama").Tool;
export type ToolCall = import("ollama").ToolCall;
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
export type BackgroundMessage = {
    id: string;
    author: string;
    content: string;
    isAssistant?: boolean;
    replyTo?: string | null;
    channelId?: string;
    channelName?: string;
};
export type MemoryFact = {
    id: number;
    fact: string;
    by?: string;
    at?: string;
};
export type GenerationUpdate = {
    text: string;
    status: ToolCall | "";
    final: boolean;
    modelAlias?: string;
};
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
export type SessionOptions = {
    conversation: ChatMessage[];
    background?: BackgroundMessage[];
    context?: RequestContext;
    think?: boolean;
    assistantName?: string;
    platformInstructions?: string;
    onUpdate?: (arg0: GenerationUpdate) => (void | Promise<void>);
    onQueued?: (arg0: number) => (void | Promise<void>);
};
export type Session = {
    stop: () => void;
    run: () => Promise<GenerationResult>;
};
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
export type MemoryStore = ReturnType<typeof import("./core/memory.ts").createMemoryStore>;
export type ToolService = {
    runTool: (call: ToolCall, context: RequestContext) => Promise<string>;
    searchEnabled: boolean;
    definitions: (options: {
        scopeId?: string;
        history?: boolean;
        images?: boolean;
    }) => ToolDefinition[];
};
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
    supervisor?: ReturnType<typeof import("./core/supervisor.ts").createSupervisor>;
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
export type AppConfig = {
    token: string | undefined;
    telegramToken: string | undefined;
    telegramTimeoutMs: number;
    telegramUpdateIntervalMs: number;
    adapters: string[];
    applicantId: string | undefined;
    publicKey: string | undefined;
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
export type TelegramRequest = (arg0: string, arg1?: {
    [x: string]: any;
} | undefined, arg2?: CancellationSignal) => Promise<any>;
export type TelegramApi = TelegramRequest & {
    downloadImage: (arg0: string) => Promise<string>;
};
export type TelegramBot = {
    handleUpdate: (arg0: import("@grammyjs/types").Update) => Promise<void>;
    start: () => Promise<void>;
    stop: () => (Promise<void> | undefined);
};
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
export type CancellationSignal = Pick<AbortSignal, "aborted" | "addEventListener" | "removeEventListener">;
export type TerminalRequest = {
    id: number;
    text?: string;
    thinking?: string;
    status?: string;
    authorName?: string;
    startedAt?: number;
    [key: string]: unknown;
};
export type TerminalState = {
    current: TerminalRequest | null;
    last?: TerminalRequest | null;
    queue: TerminalRequest[];
};

export type ObservedMessage = { scopeId?: string; roomId: string; id?: string; text: string; authorName: string };
export type ModelStream = AsyncIterable<import("ollama").ChatResponse> & { abort(): void };
export type WebSearchResult = { title?: string; url?: string; content: string };
export type WebClient = {
  webSearch(request: { query: string; max_results?: number }): Promise<{ results: WebSearchResult[] }>;
  webFetch(request: { url: string }): Promise<{ content: string; title?: string; links?: string[] }>;
};

export type HttpFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
