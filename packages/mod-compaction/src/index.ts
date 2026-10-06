export {
	COMPACTION_ID,
	type CommandRecord,
	createCompaction,
	type Facts,
	renderSummary,
} from "./compaction.ts";
export { type CompactionSettings, parseSettings, SettingsSchema as CompactionSettingsSchema } from "./settings.ts";
