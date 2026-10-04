import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		include: ["packages/*/test/**/*.test.ts"],
		testTimeout: 5_000,
		coverage: {
			provider: "v8",
			include: ["packages/*/src/**/*.ts"],
			// Thin CLI entrypoints: argument parsing over tested functions, exercised by hand and in CI.
			exclude: ["packages/*/src/cli.ts", "packages/*/src/*-cli.ts"],
			reporter: ["text-summary", "html"],
			// A ratchet, not a target: raise these when coverage rises, never lower them to merge.
			thresholds: { statements: 93, branches: 83, functions: 94, lines: 95 },
		},
	},
});
