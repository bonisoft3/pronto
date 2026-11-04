import { strict as assert } from "node:assert";

function worker() {
	return new Worker(new URL("./worker.ts", import.meta.url).href, {
		type: "module",
	});
}
function exchange(target: Worker, message: unknown): Promise<unknown> {
	return new Promise((resolve, reject) => {
		target.onmessage = (event) => resolve(event.data);
		target.onerror = (event) => reject(new Error(event.message));
		target.postMessage(message);
	});
}
Deno.test("fresh worker invokes a registered published action", async () => {
	const target = worker();
	try {
		const result = await exchange(target, { kind: "invoke" }) as {
			query_parameters: unknown;
		};
		assert.deepEqual(result.query_parameters, { a: "1" });
	} finally {
		target.terminate();
	}
});
Deno.test("worker environment mutation is observed by host and sibling", async () => {
	const old = Deno.env.get("HATCH_SPIKE_MARKER");
	Deno.env.set("HATCH_SPIKE_MARKER", "host-value");
	const first = worker();
	const second = worker();
	try {
		await exchange(first, { kind: "set-env" });
		assert.equal(Deno.env.get("HATCH_SPIKE_MARKER"), "worker-value");
		assert.equal(await exchange(second, { kind: "read-env" }), "worker-value");
	} finally {
		first.terminate();
		second.terminate();
		if (old === undefined) Deno.env.delete("HATCH_SPIKE_MARKER");
		else Deno.env.set("HATCH_SPIKE_MARKER", old);
	}
});
Deno.test("terminating a worker prevents a scheduled request", async () => {
	let requests = 0;
	const server = Deno.serve(
		{ hostname: "127.0.0.1", port: 0, onListen() {} },
		() => {
			requests++;
			return new Response("ok");
		},
	);
	const target = worker();
	try {
		assert.equal(
			await exchange(target, {
				kind: "schedule",
				url: `http://127.0.0.1:${server.addr.port}/`,
			}),
			"scheduled",
		);
		target.terminate();
		await new Promise((resolve) => setTimeout(resolve, 400));
		assert.equal(requests, 0);
	} finally {
		target.terminate();
		await server.shutdown();
	}
});

Deno.test("clearEnv child mutation stays in child", async () => {
	const old = Deno.env.get("HATCH_SPIKE_MARKER");
	Deno.env.set("HATCH_SPIKE_MARKER", "host-value");
	try {
		const child = await new Deno.Command(Deno.execPath(), {
			args: ["run", "--allow-env=HATCH_SPIKE_MARKER", "child.ts"],
			clearEnv: true,
			stdout: "piped",
			stderr: "piped",
		}).output();
		assert.equal(child.success, true, new TextDecoder().decode(child.stderr));
		assert.deepEqual(JSON.parse(new TextDecoder().decode(child.stdout)), {
			before: null,
			after: "child-value",
		});
		assert.equal(Deno.env.get("HATCH_SPIKE_MARKER"), "host-value");
	} finally {
		if (old === undefined) Deno.env.delete("HATCH_SPIKE_MARKER");
		else Deno.env.set("HATCH_SPIKE_MARKER", old);
	}
});
