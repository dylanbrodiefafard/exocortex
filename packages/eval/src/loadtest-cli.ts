#!/usr/bin/env node
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { type EngineProfile, loadConfig, resolveEngine } from "@exocortex/core";
import { renderLoadTestMarkdown, runLoadTest } from "./loadtest.ts";

const REPO_ROOT = resolve(import.meta.dirname, "..", "..", "..");

const USAGE = `Usage: npm run loadtest -- --base-url <url> --model <id> [options]

Phase 2 acceptance (brief §8): main-agent latency alone vs. with the sidecar pool saturated.
Unset engine/pool options come from your Exocortex config (~/.exocortex/config.jsonc).

Options:
  --base-url <url>         OpenAI-compatible base URL incl. /v1 (default: config engine.baseUrl)
  --model <id>             Model id (default: config engine.model)
  --api-key <key>          API key (default: config engine.apiKey)
  --profile <name>         generic | vllm | sglang | llamacpp | ninfer (default: config)
  --max-concurrent <n>     Engine slots (default: config pool.maxConcurrent)
  --reserved <n>           Slots reserved for main (default: config pool.reservedForMain)
  --main-requests <n>      Main requests per phase (default 8)
  --context-tokens <n>     Main shared-context size (default 16000)
  --main-max-tokens <n>    Main output tokens per request (default 256)
  --sidecars <n>           Sidecar calls kept in flight during the loaded phase (default 20)
  --sidecar-tokens <n>     Sidecar prompt size (default 1500)
  --sidecar-max-tokens <n> Sidecar output tokens (default 128)
  --out <dir>              Output root (default: eval-runs/)`;

async function main(): Promise<number> {
	const { values } = parseArgs({
		options: {
			"base-url": { type: "string" },
			model: { type: "string" },
			"api-key": { type: "string" },
			profile: { type: "string" },
			"max-concurrent": { type: "string" },
			reserved: { type: "string" },
			"main-requests": { type: "string", default: "8" },
			"context-tokens": { type: "string", default: "16000" },
			"main-max-tokens": { type: "string", default: "256" },
			sidecars: { type: "string", default: "20" },
			"sidecar-tokens": { type: "string", default: "1500" },
			"sidecar-max-tokens": { type: "string", default: "128" },
			out: { type: "string", default: join(REPO_ROOT, "eval-runs") },
			help: { type: "boolean", short: "h", default: false },
		},
	});
	if (values.help) {
		process.stdout.write(`${USAGE}\n`);
		return 0;
	}

	const { config, problems } = loadConfig({ cwd: process.cwd() });
	if (problems.length > 0) process.stderr.write(`config problems (using defaults): ${problems.join("; ")}\n`);
	const engine = {
		...config.engine,
		...(values["base-url"] ? { baseUrl: values["base-url"] } : {}),
		...(values.model ? { model: values.model } : {}),
		...(values["api-key"] ? { apiKey: values["api-key"] } : {}),
		...(values.profile ? { profile: values.profile as EngineProfile } : {}),
	};
	const target = resolveEngine(engine);
	if (!target) {
		process.stderr.write(`Need --base-url and --model (or engine.baseUrl/model in config).\n\n${USAGE}\n`);
		return 2;
	}
	const int = (value: string | undefined, fallback: number) =>
		value === undefined ? fallback : Number.parseInt(value, 10);

	const stamp = new Date().toISOString().replace(/[:.]/g, "-");
	const report = await runLoadTest({
		target,
		maxConcurrent: int(values["max-concurrent"], config.pool.maxConcurrent),
		reservedForMain: int(values.reserved, config.pool.reservedForMain),
		mainRequests: int(values["main-requests"], 8),
		mainContextTokens: int(values["context-tokens"], 16000),
		mainMaxTokens: int(values["main-max-tokens"], 256),
		sidecarBacklog: int(values.sidecars, 20),
		sidecarPromptTokens: int(values["sidecar-tokens"], 1500),
		sidecarMaxTokens: int(values["sidecar-max-tokens"], 128),
		sidecarTimeoutMs: 120_000,
		log: (line) => process.stdout.write(`${line}\n`),
	});

	const markdown = renderLoadTestMarkdown(report, `Sidecar load test ${stamp} · ${target.model}`);
	const dir = join(resolve(values.out), `loadtest-${stamp}`);
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "report.json"), JSON.stringify(report, null, 2));
	writeFileSync(join(dir, "summary.md"), markdown);
	process.stdout.write(`\n${markdown}\nWrote ${join(dir, "summary.md")}\n`);
	// No sidecar completed: the report says so, and the exit code must not read as a pass.
	return report.regression ? 0 : 1;
}

main().then(
	(code) => {
		process.exitCode = code;
	},
	(error: unknown) => {
		process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
		process.exitCode = 1;
	},
);
