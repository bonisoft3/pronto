import { http } from "http-piece";

const registry = {
	http: { piece: http, actions: ["send_request", "parse_url"] },
} as const;

export function descriptor() {
	return Object.entries(registry).map(([name, entry]) => ({
		name,
		actions: [...entry.actions],
	}));
}

export async function invoke(
	piece: string,
	action: string,
	propsValue: Record<string, unknown>,
	auth?: unknown,
) {
	if (!Object.hasOwn(registry, piece)) {
		throw new Error(`Unknown piece: ${piece}`);
	}
	const entry = registry[piece as keyof typeof registry];
	if (!(entry.actions as readonly string[]).includes(action)) {
		throw new Error(`Action not exposed: ${action}`);
	}
	const selected = entry.piece.getAction(action);
	if (!selected) throw new Error(`Missing action: ${action}`);
	const context = new Proxy({ auth, propsValue }, {
		get(target, property) {
			if (property === "auth" || property === "propsValue") {
				return target[property];
			}
			throw new Error(`Unsupported context capability: ${String(property)}`);
		},
	});
	return await selected.run(context as Parameters<typeof selected.run>[0]);
}

export const parseUrl = http.getAction("parse_url")!;
