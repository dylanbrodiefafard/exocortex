export { type ConfigSource, type ExoConfig, type LoadConfigOptions, type LoadedConfig, loadConfig } from "./config.ts";
export { createDebugLog, type DebugFields, type DebugLog, type DebugLogOptions, type DebugValue } from "./debug-log.ts";
export { type ChatRequestFingerprint, canonicalJson, fingerprintChatRequest, sharedPrefix } from "./fingerprint.ts";
export {
	type ChatMessage,
	type ChatRequest,
	type ChatResponse,
	type ChatUsage,
	createOpenAIClient,
	type InferenceClient,
	InferenceError,
} from "./inference/client.ts";
export {
	cosineSimilarity,
	createEmbedder,
	decodeVector,
	type Embedder,
	encodeVector,
	resolveEmbeddings,
} from "./inference/embeddings.ts";
export {
	ENGINE_PROFILES,
	type EngineFallback,
	type EngineFeatures,
	type EngineProfile,
	type EngineTarget,
	resolveEngine,
} from "./inference/engine.ts";
export {
	createSidecarPool,
	type ModuleLimits,
	moduleLimitsFrom,
	type PoolStats,
	type SidecarCall,
	type SidecarCallRecord,
	type SidecarOutcome,
	type SidecarPool,
	type SidecarPoolOptions,
	type SidecarPriority,
	type SidecarResult,
	type SidecarUsage,
} from "./inference/pool.ts";
export { completeStructured, extractJson, StructuredOutputError } from "./inference/structured.ts";
export { type ToJsonOptions, toJsonValue } from "./json.ts";
export { type CommandOutput, killGroup, runProcess, runShellCommand } from "./modules/command.ts";
export {
	classifyErrorLine,
	cleanTerminalOutput,
	type ErrorLineKind,
	errorLineIndices,
	errorSignature,
	firstErrorLine,
	isTestPath,
	normalizeErrorLine,
	ungroundedReferences,
} from "./modules/output.ts";
export { loadPrompt, type PromptTemplate, renderPrompt } from "./modules/prompts.ts";
export type {
	CompactionRequest,
	Dialog,
	ExoModule,
	ModuleContext,
	ModuleFactory,
	SettleAction,
	SettleInfo,
	ToolOutcome,
	ToolResultDraft,
	ToolRewrite,
	UserTurn,
} from "./modules/types.ts";
export { openDatabase } from "./trace/sqlite.ts";
export {
	type JsonValue,
	openTraceStore,
	type SessionInfo,
	type StoredSession,
	type StoredTraceEvent,
	TRACE_EVENT_KINDS,
	type TraceEventInput,
	type TraceEventKind,
	type TraceSession,
	type TraceStore,
	type TraceStoreOptions,
} from "./trace/store.ts";
