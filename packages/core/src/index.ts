export {
	type ConfigSource,
	type ExoConfig,
	type LoadConfigOptions,
	type LoadedConfig,
	loadConfig,
	type ModuleSettingsSchemas,
} from "./config.ts";
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
	type DrainResult,
	type ModuleLimits,
	moduleLimitsFrom,
	type PoolStats,
	SIDECAR_MAX_TOKENS,
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
export { type FileEdit, fileEdits } from "./modules/edits.ts";
export {
	callKey,
	failureKey,
	failureLines,
	type Loop,
	loopHistoryLength,
	MAX_LOOP_PERIOD,
	trailingLoop,
} from "./modules/loops.ts";
export {
	classifyErrorLine,
	cleanTerminalOutput,
	type ErrorLineKind,
	errorLineIndices,
	errorSignature,
	firstErrorLine,
	isRoutineLine,
	isTestPath,
	type LineVerdict,
	lineVerdicts,
	normalizeErrorLine,
	ungroundedReferences,
} from "./modules/output.ts";
export { loadPrompt, type PromptTemplate, renderPrompt } from "./modules/prompts.ts";
export {
	BENIGN_EXIT_COMMANDS,
	type HiddenRunReading,
	hiddenRun,
	isBenignExit,
	judgeHiddenRun,
	maskedFailure,
	outcomeOf,
	type RunOptions,
	type RunVerdict,
	readHiddenRun,
	type VerifyingRun,
	verifyingRun,
} from "./modules/runs.ts";
export { commandBase, type ShellCommand, shellCommands, splitCommand, unwrapCommand } from "./modules/shell.ts";
export type {
	Committable,
	CompactionRequest,
	CompactionSummary,
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
	UserTurnContext,
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
