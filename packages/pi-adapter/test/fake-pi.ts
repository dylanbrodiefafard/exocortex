import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";

type Handler = (event: unknown, ctx: unknown) => unknown;
type CommandSpec = Parameters<ExtensionAPI["registerCommand"]>[1];

export interface UiCall {
	readonly method: "notify" | "setStatus" | "setEditorText" | "setWorkingMessage" | "select" | "input";
	readonly args: readonly unknown[];
}

/** An in-process stand-in for pi's ExtensionAPI: records handlers and lets tests emit events. */
export interface FakePi {
	readonly api: ExtensionAPI;
	readonly commands: ReadonlyMap<string, CommandSpec>;
	readonly ui: UiCall[];
	/** What the user answers to the next `select` and `input` dialogs, in order; none left means they cancel. */
	readonly answers: string[];
	/** Calls every handler for `name` in registration order; returns the last non-undefined result. */
	emit(name: string, event?: Record<string, unknown>, ctx?: ExtensionContext): Promise<unknown>;
	/** Runs `/name args`. */
	command(name: string, args?: string): Promise<void>;
	ctx(overrides?: Partial<Record<string, unknown>>): ExtensionContext & ExtensionCommandContext;
}

export function createFakePi(options: { cwd: string; hasUI?: boolean; flags?: Record<string, unknown> }): FakePi {
	const handlers = new Map<string, Handler[]>();
	const commands = new Map<string, CommandSpec>();
	const ui: UiCall[] = [];
	const answers: string[] = [];
	const flags = { ...options.flags };

	const api = {
		on(name: string, handler: Handler) {
			handlers.set(name, [...(handlers.get(name) ?? []), handler]);
		},
		registerCommand(name: string, spec: CommandSpec) {
			commands.set(name, spec);
		},
		registerFlag(name: string, spec: { default?: unknown }) {
			if (!(name in flags)) flags[name] = spec.default;
		},
		getFlag: (name: string) => flags[name],
	} as unknown as ExtensionAPI;

	function ctx(overrides: Partial<Record<string, unknown>> = {}) {
		return {
			cwd: options.cwd,
			hasUI: options.hasUI ?? true,
			model: undefined,
			modelRegistry: { getApiKeyForProvider: async () => undefined },
			sessionManager: { getSessionId: () => "fake-session", getSessionFile: () => undefined },
			ui: {
				notify: (...args: unknown[]) => ui.push({ method: "notify", args }),
				setStatus: (...args: unknown[]) => ui.push({ method: "setStatus", args }),
				setEditorText: (...args: unknown[]) => ui.push({ method: "setEditorText", args }),
				setWorkingMessage: (...args: unknown[]) => ui.push({ method: "setWorkingMessage", args }),
				select: async (...args: unknown[]) => {
					ui.push({ method: "select", args });
					return answers.shift();
				},
				input: async (...args: unknown[]) => {
					ui.push({ method: "input", args });
					return answers.shift();
				},
			},
			...overrides,
		} as unknown as ExtensionContext & ExtensionCommandContext;
	}

	return {
		api,
		commands,
		ui,
		answers,
		ctx,
		async emit(name, event = {}, context = ctx()) {
			let result: unknown;
			for (const handler of handlers.get(name) ?? []) {
				const value = await handler({ type: name, ...event }, context);
				if (value !== undefined) result = value;
			}
			return result;
		},
		async command(name, args = "") {
			const spec = commands.get(name);
			if (!spec) throw new Error(`no command /${name}`);
			await spec.handler(args, ctx());
		},
	};
}
