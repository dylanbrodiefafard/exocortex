import type { ModuleSettingsSchemas } from "@exocortex/core";
import { COMPACTION_ID, CompactionSettingsSchema } from "@exocortex/mod-compaction";
import { MEMORY_ID, MemorySettingsSchema } from "@exocortex/mod-memory";
import { SUPERVISOR_ID, SupervisorSettingsSchema } from "@exocortex/mod-supervisor";
import { TRIAGE_ID, TriageSettingsSchema } from "@exocortex/mod-triage";
import { TRIMMER_ID, TrimmerSettingsSchema } from "@exocortex/mod-trimmer";

/**
 * Every module Exocortex ships, with the schema of its settings. Config is checked against this
 * when it loads (D-080), so a mistyped module id or setting disables Exocortex with a warning
 * (D-033) instead of silently doing nothing. Core cannot import the modules, so the adapter
 * hands it this map.
 */
export const MODULE_SETTINGS: ModuleSettingsSchemas = {
	[TRIMMER_ID]: TrimmerSettingsSchema,
	[TRIAGE_ID]: TriageSettingsSchema,
	[MEMORY_ID]: MemorySettingsSchema,
	[SUPERVISOR_ID]: SupervisorSettingsSchema,
	[COMPACTION_ID]: CompactionSettingsSchema,
};
