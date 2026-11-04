import { invoke } from "./runner.ts";

const scope = globalThis as unknown as {
	onmessage: (event: MessageEvent<{ kind: string; url?: string }>) => void;
	postMessage(value: unknown): void;
};
scope.onmessage = (event: MessageEvent<{ kind: string; url?: string }>) => {
	if (event.data.kind === "invoke") {
		invoke("http", "parse_url", { url: "https://example.test/?a=1&a=2" }).then((
			result,
		) => scope.postMessage(result));
	} else if (event.data.kind === "set-env") {
		Deno.env.set("HATCH_SPIKE_MARKER", "worker-value");
		scope.postMessage("set");
	} else if (event.data.kind === "read-env") {
		scope.postMessage(Deno.env.get("HATCH_SPIKE_MARKER") ?? null);
	} else if (event.data.kind === "schedule") {
		const url = event.data.url!;
		setTimeout(() => fetch(url), 200);
		scope.postMessage("scheduled");
	} else {
		throw new Error(`Unknown operation: ${event.data.kind}`);
	}
};
