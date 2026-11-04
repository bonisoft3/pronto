export type Context = Record<string, unknown>;
export interface Trigger {
	name: string;
	type: string;
	onEnable(context: Context): Promise<unknown>;
	onDisable(context: Context): Promise<unknown>;
	run(context: Context): Promise<unknown[]>;
}
export interface State {
	stores: Record<string, Record<string, unknown>>;
	receipts: string[];
	events: { source: string; payload: unknown }[];
}

// Single-process spike: the snapshot is an atomic checkpoint/outbox boundary,
// not a substitute for a transactional database or distributed leases.
export class Host {
	constructor(readonly file: string) {}
	async state(): Promise<State> {
		return JSON.parse(await Deno.readTextFile(this.file));
	}
	async initialize() {
		await Deno.writeTextFile(
			this.file,
			JSON.stringify({ stores: {}, receipts: [], events: [] }),
		);
	}
	async invoke(
		source: string,
		trigger: Trigger,
		hook: "onEnable" | "onDisable" | "run",
		input: Context,
		options: { receipt?: string; failBeforeCommit?: boolean } = {},
	) {
		const state = await this.state();
		const receipt = options.receipt === undefined
			? undefined
			: JSON.stringify([source, options.receipt]);
		if (receipt !== undefined && state.receipts.includes(receipt)) return [];
		const data = state.stores[source] ??= {};
		const store = {
			get: (key: string) => Promise.resolve(structuredClone(data[key] ?? null)),
			put: (key: string, value: unknown) => {
				data[key] = structuredClone(value);
				return Promise.resolve();
			},
			delete: (key: string) => {
				delete data[key];
				return Promise.resolve();
			},
		};
		const context = new Proxy({ ...input, store }, {
			get(target, key) {
				if (typeof key === "string" && !(key in target)) {
					throw new Error(`Unsupported context capability: ${key}`);
				}
				return Reflect.get(target, key);
			},
		});
		const result = await trigger[hook](context);
		const events = hook === "run" ? result : [];
		if (!Array.isArray(events)) throw new Error("Trigger must return an array");
		state.events.push(...events.map((payload) => ({ source, payload })));
		if (receipt !== undefined) state.receipts.push(receipt);
		if (options.failBeforeCommit) throw new Error("Injected commit failure");
		await Deno.writeTextFile(`${this.file}.pending`, JSON.stringify(state));
		await Deno.rename(`${this.file}.pending`, this.file);
		return events;
	}
}
