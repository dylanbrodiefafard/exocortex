export { asksUserQuestion, diffFingerprint, fitDiff, formatEvidence, touchedFiles } from "./evidence.ts";
export { parseSettings, SettingsSchema as SupervisorSettingsSchema, type SupervisorSettings } from "./settings.ts";
export {
	type Claim,
	type ClaimKind,
	type DiffFile,
	extractClaims,
	isNarrowTest,
	lastFullRun,
	madeNoChanges,
	narrowTestSignal,
	parseDiff,
	stubSignals,
	type TestRun,
	tamperSignals,
	testRunNotes,
	unsupportedClaims,
} from "./signals.ts";
export {
	aggregateItems,
	continuationMessage,
	createSupervisor,
	type ItemVerdict,
	type Judgement,
	type Ledger,
	preVerdict,
	SUPERVISOR_ID,
	type Verdict,
	verificationMessage,
	warningsFor,
} from "./supervisor.ts";
