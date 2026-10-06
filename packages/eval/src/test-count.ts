/**
 * How many tests a check ran and passed, read from its runner's own summary (D-079). The eval
 * compares it with what the reference solution's check ran: a check that exits 0 after running
 * fewer tests did not test the work. Null when the output has no summary this knows.
 *
 * The first runner whose summary appears decides, in this order, so the same check command gives
 * the same kind of count for the solution and for the agent:
 * - cargo: every `test result: ok. N passed` line, summed over test binaries;
 * - Python unittest: `Ran N tests`, less `skipped=K`;
 * - pytest: `N passed`;
 * - Go with `-v`: `--- PASS` lines; without it, packages reported `ok` (Go prints no test count);
 * - CTest: `N tests failed out of M`;
 * - TAP: `ok N` lines not marked `# SKIP`;
 * - a plain `N tests, 0 failures` line, as hand-written C++ runners print.
 */
export function countPassedTests(output: string): number | null {
	const cargo = [...output.matchAll(/^test result: \w+\. (\d+) passed;/gm)];
	if (cargo.length > 0) return total(cargo);

	const unittest = [...output.matchAll(/^Ran (\d+) tests? in /gm)];
	if (unittest.length > 0) return total(unittest) - total([...output.matchAll(/^OK \(.*?skipped=(\d+)/gm)]);

	const pytest = [...output.matchAll(/^=+ .*?\b(\d+) passed\b.* in [\d.]+s/gm)];
	if (pytest.length > 0) return total(pytest);

	const goVerbose = output.match(/^\s*--- PASS: /gm);
	if (goVerbose) return goVerbose.length;
	const goPackages = output.match(/^ok\s+\S+\s+(\(cached\)|[\d.]+s)/gm);
	if (goPackages) return goPackages.length;

	const ctest = output.match(/tests passed, (\d+) tests failed out of (\d+)/);
	if (ctest) return Number(ctest[2]) - Number(ctest[1]);

	const tap = output.match(/^ok \d+\b(?!.*# (?:SKIP|skip))/gm);
	if (tap) return tap.length;

	const plain = output.match(/^(\d+) tests?, 0 failures\b/m);
	if (plain) return Number(plain[1]);

	return null;
}

function total(matches: readonly RegExpMatchArray[]): number {
	return matches.reduce((sum, match) => sum + Number(match[1]), 0);
}
