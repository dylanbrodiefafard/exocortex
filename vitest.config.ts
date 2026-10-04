import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		include: ["packages/*/test/**/*.test.ts"],
		exclude: ["**/*.e2e.test.ts", "**/node_modules/**"],
		testTimeout: 5_000,
	},
});
