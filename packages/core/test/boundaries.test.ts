import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const SRC = join(import.meta.dirname, "..", "src");

function sourceFiles(dir: string): string[] {
	return readdirSync(dir, { withFileTypes: true, recursive: true })
		.filter((entry) => entry.isFile() && entry.name.endsWith(".ts"))
		.map((entry) => join(entry.parentPath, entry.name));
}

describe("core package boundaries", () => {
	it("never imports pi or any harness package (brief §3)", () => {
		const offenders = sourceFiles(SRC).filter((file) =>
			/from\s+["'](@earendil-works|@mariozechner)\//.test(readFileSync(file, "utf8")),
		);
		expect(offenders).toEqual([]);
	});
});
