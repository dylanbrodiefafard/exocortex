export { asksUserQuestion, diffFingerprint, formatEvidence, touchedFiles } from "./evidence.ts";
export { parseSettings, type SupervisorSettings } from "./settings.ts";
export {
	type Claim,
	type ClaimKind,
	type DiffFile,
	extractClaims,
	madeNoChanges,
	narrowTestSignal,
	parseDiff,
	stubSignals,
	tamperSignals,
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
	warningsFor,
} from "./supervisor.ts";
