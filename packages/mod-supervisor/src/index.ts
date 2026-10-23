export { diffFingerprint, fitDiff, formatEvidence, touchedFiles } from "./evidence.ts";
export { parseSettings, SettingsSchema as SupervisorSettingsSchema, type SupervisorSettings } from "./settings.ts";
export {
	admitClaims,
	type Claim,
	type ClaimKind,
	type DiffFile,
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
	continuationMessage,
	createSupervisor,
	type Judgement,
	type Ledger,
	SUPERVISOR_ID,
	type Verdict,
	verificationMessage,
	warningsFor,
} from "./supervisor.ts";
