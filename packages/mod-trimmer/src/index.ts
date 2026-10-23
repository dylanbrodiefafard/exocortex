export {
	NEVER_TRIMMED,
	parseSettings,
	SettingsSchema as TrimmerSettingsSchema,
	type TrimmerSettings,
} from "./settings.ts";
export { type Line, prepareLines, renderSelection, selectLines, type Trimmed, type TrimOptions } from "./trim.ts";
export { createTrimmer, TRIMMER_ID } from "./trimmer.ts";
