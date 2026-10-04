import type { ExtensionEvent } from "@earendil-works/pi-coding-agent";

export type PiEventName = ExtensionEvent["type"];

/** Every pi extension event, in rough lifecycle order. Kept exhaustive by a type test. */
export const PI_EVENT_NAMES = [
	"project_trust",
	"resources_discover",
	"session_start",
	"session_info_changed",
	"mcp_servers_change",
	"model_select",
	"thinking_level_select",
	"input",
	"user_bash",
	"before_agent_start",
	"agent_start",
	"turn_start",
	"context",
	"context_with_system",
	"cache_warming_decision",
	"before_provider_headers",
	"before_provider_request",
	"after_provider_response",
	"provider_stream_event",
	"message_start",
	"message_update",
	"message_end",
	"tool_execution_start",
	"tool_call",
	"tool_execution_update",
	"tool_result",
	"tool_execution_end",
	"turn_end",
	"agent_end",
	"agent_before_settle",
	"agent_settled",
	"ui_prompt_start",
	"ui_prompt_end",
	"session_before_compact",
	"session_compact",
	"session_compact_failed",
	"session_before_tree",
	"session_tree",
	"session_before_fork",
	"session_before_switch",
	"session_shutdown",
] as const satisfies readonly PiEventName[];

/** Names missing from {@link PI_EVENT_NAMES}; must be `never`. */
export type UnlistedPiEvent = Exclude<PiEventName, (typeof PI_EVENT_NAMES)[number]>;

/** Per-token or per-chunk events, logged only at verbose level. */
export const HIGH_FREQUENCY_EVENTS: ReadonlySet<PiEventName> = new Set([
	"message_update",
	"provider_stream_event",
	"tool_execution_update",
]);
