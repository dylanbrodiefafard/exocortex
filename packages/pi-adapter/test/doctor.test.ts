import {
	createOpenAIClient,
	createSidecarPool,
	ENGINE_PROFILES,
	type EngineTarget,
	type ForkPrefix,
} from "@exocortex/core";
import { type FakeOpenAIServer, type ScriptedReply, startFakeOpenAIServer } from "@exocortex/testkit";
import { afterEach, describe, expect, it } from "vitest";
import { doctorReport, runDoctor } from "../src/doctor.ts";

let server: FakeOpenAIServer | undefined;
afterEach(async () => {
	await server?.close();
	server = undefined;
});

interface Request {
	readonly ninfer?: unknown;
	readonly response_format?: unknown;
}

/** A fake engine: refuses `ninfer` unless told it has it, honours json_schema when told to, reports cached tokens. */
async function engine(options: { readOnly?: boolean; jsonSchema?: boolean; cached?: number | undefined } = {}) {
	server = await startFakeOpenAIServer([], {
		respond: (body): ScriptedReply => {
			const request = body as Request;
			if (request.ninfer && !options.readOnly)
				return { kind: "error", status: 400, message: "ninfer.cache_write is not supported" };
			const cached = options.cached === undefined ? {} : { cachedTokens: options.cached };
			if (request.response_format && options.jsonSchema)
				return { kind: "text", text: '{"greeting":"Hello there."}', ...cached };
			return { kind: "text", text: "pong", ...cached };
		},
	});
	return server.baseUrl;
}

const target = (baseUrl: string, features: Partial<EngineTarget["features"]> = {}): EngineTarget => ({
	baseUrl,
	model: "m",
	apiKey: undefined,
	features: { ...ENGINE_PROFILES.generic, ...features },
});

const noFork = async () => undefined;
const byCheck = (findings: Awaited<ReturnType<typeof runDoctor>>) =>
	Object.fromEntries(findings.map((f) => [f.check, f.status]));

describe("/exo doctor (D-099)", () => {
	it("says there is nothing to check without an engine", async () => {
		const findings = await runDoctor({
			engine: undefined,
			profile: undefined,
			pool: undefined,
			embedder: undefined,
			fork: noFork,
		});
		expect(findings).toEqual([expect.objectContaining({ status: "fail", check: "engine" })]);
		expect(doctorReport(findings)).toMatch(/^Exocortex doctor: 1 problem\(s\)/);
	});

	it("finds a profile that sends what the server refuses, and features the profile leaves unused", async () => {
		const baseUrl = await engine({ readOnly: false, jsonSchema: true, cached: 3 });
		const findings = await runDoctor({
			engine: target(baseUrl, { cacheReadOnly: true, cachedTokens: true }),
			profile: "dylanbrodiefafard/ninfer",
			pool: undefined,
			embedder: undefined,
			fork: noFork,
		});
		expect(byCheck(findings)).toEqual({
			engine: "ok",
			answers: "ok",
			streams: "ok",
			"cached tokens": "ok",
			"read-only cache": "fail",
			"json schema": "warn",
			fork: "skip",
			embeddings: "skip",
		});
		const report = doctorReport(findings);
		expect(report).toContain("1 problem(s) and 1 warning(s)");
		expect(report).toContain("set engine.features.cacheReadOnly: false");
		expect(report).toContain("set engine.features.jsonSchema: true");
	});

	it("passes a server that matches its profile, and says when cached tokens are missing", async () => {
		const good = await engine({ readOnly: true, jsonSchema: true, cached: 3 });
		const ok = await runDoctor({
			engine: target(good, { cacheReadOnly: true, cachedTokens: true, jsonSchema: true }),
			profile: "dylanbrodiefafard/ninfer",
			pool: undefined,
			embedder: undefined,
			fork: noFork,
		});
		expect(ok.filter((f) => f.status === "fail" || f.status === "warn")).toEqual([]);
		expect(doctorReport(ok)).toMatch(/^Exocortex doctor: all good/);
		await server?.close();

		// A server that ignores response_format: the probe asks for prose, so the reply is prose.
		const ignoring = await engine({ readOnly: true, jsonSchema: false, cached: 3 });
		const fooled = await runDoctor({
			engine: target(ignoring, { cacheReadOnly: true, cachedTokens: true, jsonSchema: true }),
			profile: "dylanbrodiefafard/ninfer",
			pool: undefined,
			embedder: undefined,
			fork: noFork,
		});
		expect(byCheck(fooled)["json schema"]).toBe("fail");
		await server?.close();

		const silent = await engine({ cached: undefined });
		const missing = await runDoctor({
			engine: target(silent, { cachedTokens: true }),
			profile: "generic",
			pool: undefined,
			embedder: undefined,
			fork: noFork,
		});
		expect(byCheck(missing)["cached tokens"]).toBe("fail");
	});

	it("continues the agent's context and says whether the cache served it", async () => {
		const fork: ForkPrefix = { body: { model: "m", messages: [{ role: "user", content: "a long conversation" }] } };
		for (const [cached, status] of [
			[200, "ok"],
			[0, "fail"],
		] as const) {
			const baseUrl = await engine({ readOnly: true, cached });
			const features = { cacheReadOnly: true, cachedTokens: true };
			const pool = createSidecarPool({
				client: createOpenAIClient(target(baseUrl, features)),
				target: target(baseUrl, features),
				config: { maxConcurrent: 4, reservedForMain: 1, sessionTokenBudget: 0, backgroundWhenIdleOnly: true },
				moduleLimits: () => ({ maxTokensPerCall: 64 }),
			});
			const findings = await runDoctor({
				engine: target(baseUrl, features),
				profile: "dylanbrodiefafard/ninfer",
				pool,
				embedder: undefined,
				fork: async () => fork,
			});
			expect(findings.find((f) => f.check === "fork")?.status).toBe(status);
			await server?.close();
			server = undefined;
		}
	});

	it("measures, when asked, whether a fork can turn thinking off and keep the cache, and says what to set (D-100)", async () => {
		const fork: ForkPrefix = {
			body: {
				model: "m",
				chat_template_kwargs: { enable_thinking: true },
				messages: [{ role: "user", content: "context" }],
			},
		};
		const features = { cacheReadOnly: true, cachedTokens: true };
		for (const [keepsPrefix, status] of [
			[true, "warn"],
			[false, "skip"],
		] as const) {
			server = await startFakeOpenAIServer([], {
				respond: (body) => {
					const off =
						(body as { chat_template_kwargs?: { enable_thinking?: boolean } }).chat_template_kwargs?.enable_thinking ===
						false;
					return { kind: "text", text: "ok", cachedTokens: off && !keepsPrefix ? 0 : 200 };
				},
			});
			const baseUrl = server.baseUrl;
			const pool = createSidecarPool({
				client: createOpenAIClient(target(baseUrl, features)),
				target: target(baseUrl, features),
				config: { maxConcurrent: 4, reservedForMain: 1, sessionTokenBudget: 0, backgroundWhenIdleOnly: true },
				moduleLimits: () => ({ maxTokensPerCall: 64 }),
			});
			const findings = await runDoctor({
				engine: target(baseUrl, features),
				profile: "dylanbrodiefafard/ninfer",
				pool,
				embedder: undefined,
				fork: async () => fork,
				probeThinking: true,
			});
			const finding = findings.find((f) => f.check === "fork without thinking");
			expect(finding?.status).toBe(status);
			if (keepsPrefix) expect(finding?.detail).toContain("set engine.features.thinkingToggle: true");
			await server.close();
			server = undefined;
		}
	});

	it("does not probe a fork without thinking unless asked, and not twice in a session (D-100)", async () => {
		const fork: ForkPrefix = { body: { model: "m", messages: [{ role: "user", content: "context" }] } };
		const baseUrl = await engine({ readOnly: true, cached: 200 });
		const features = { cacheReadOnly: true, cachedTokens: true };
		const pool = createSidecarPool({
			client: createOpenAIClient(target(baseUrl, features)),
			target: target(baseUrl, features),
			config: { maxConcurrent: 4, reservedForMain: 1, sessionTokenBudget: 0, backgroundWhenIdleOnly: true },
			moduleLimits: () => ({ maxTokensPerCall: 64 }),
		});
		const base = { engine: target(baseUrl, features), profile: "p", pool, embedder: undefined, fork: async () => fork };
		const plain = await runDoctor(base);
		expect(plain.find((f) => f.check === "fork without thinking")?.detail).toContain("/exo doctor thinking checks it");
		let remembered: Awaited<ReturnType<typeof runDoctor>>[number] | undefined;
		const thinkingFound = { get: () => remembered, set: (f: typeof remembered & object) => (remembered = f) };
		const asked = server?.requests.length ?? 0;
		await runDoctor({ ...base, probeThinking: true, thinkingFound });
		const probed = (server?.requests.length ?? 0) - asked;
		const again = await runDoctor({ ...base, probeThinking: true, thinkingFound });
		// The second run asks everything but the thinking probe again.
		expect((server?.requests.length ?? 0) - asked - probed).toBe(probed - 1);
		expect(again.find((f) => f.check === "fork without thinking")?.detail).toContain("found earlier this session");
	});

	it("stops at an engine that does not answer, and checks embeddings", async () => {
		const findings = await runDoctor({
			engine: target("http://127.0.0.1:1/v1"),
			profile: "generic",
			pool: undefined,
			embedder: undefined,
			fork: noFork,
		});
		expect(findings.at(-1)).toMatchObject({ status: "fail", check: "answers" });

		const baseUrl = await engine({ cached: 1 });
		const withEmbeddings = await runDoctor({
			engine: target(baseUrl),
			profile: "generic",
			pool: undefined,
			embedder: { model: "e", embed: async () => [Float32Array.from([1, 0, 0])] },
			fork: noFork,
		});
		expect(withEmbeddings.find((f) => f.check === "embeddings")).toMatchObject({
			status: "ok",
			detail: expect.stringContaining("3 dimensions"),
		});
		const silentEmbeddings = await runDoctor({
			engine: target(baseUrl),
			profile: "generic",
			pool: undefined,
			embedder: { model: "e", embed: async () => undefined },
			fork: noFork,
		});
		expect(silentEmbeddings.find((f) => f.check === "embeddings")?.status).toBe("warn");
	});
});
