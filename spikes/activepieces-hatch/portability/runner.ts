import { piece } from "./piece.ts";

const registry = { greeting: piece } as const;
const exposed = { greeting: ["greet", "needs-store"] } as const;
type PieceName = keyof typeof registry;

export function descriptor() {
	return Object.entries(exposed).map(([name, actions]) => ({
		name,
		actions: [...actions],
	}));
}
export async function invoke(
	name: string,
	actionName: string,
	input: Record<string, unknown>,
	secret: string,
) {
	if (!Object.hasOwn(registry, name)) throw new Error(`Unknown piece: ${name}`);
	const key = name as PieceName;
	if (!(exposed[key] as readonly string[]).includes(actionName)) {
		throw new Error(`Action not exposed: ${actionName}`);
	}
	const action = registry[key].getAction(actionName);
	if (!action) throw new Error(`Missing action: ${actionName}`);
	if (!secret) throw new Error("Missing auth");
	const context = new Proxy({
		auth: { type: "SECRET_TEXT", secret_text: secret },
		propsValue: input,
	}, {
		get(target, property) {
			if (property === "auth" || property === "propsValue") {
				return target[property];
			}
			throw new Error(`Unsupported context capability: ${String(property)}`);
		},
	});
	return await action.run(
		context as unknown as Parameters<typeof action.run>[0],
	);
}
