import { strict as assert } from "node:assert";
import { descriptor, invoke, parseUrl } from "./runner.ts";

Deno.test("static registry and raw property semantics", async () => {
	assert.deepEqual(descriptor(), [{
		name: "http",
		actions: ["send_request", "parse_url"],
	}]);
	await assert.rejects(
		() => invoke("unknown", "parse_url", {}),
		/Unknown piece/,
	);
	await assert.rejects(
		() => invoke("http", "hidden", {}),
		/Action not exposed/,
	);
	assert.equal(parseUrl.props.returnArrays.defaultValue, true);
	const url = "https://example.test/?a=1&a=2";
	const raw = await invoke("http", "parse_url", { url });
	assert.deepEqual(raw.query_parameters, { a: "1" });
	const explicit = await invoke("http", "parse_url", {
		url,
		returnArrays: true,
	});
	assert.deepEqual(explicit.query_parameters, { a: ["1", "2"] });
	await assert.rejects(
		() => invoke("http", "parse_url", {}),
		/Failed to parse URL/,
	);
	await assert.rejects(() => invoke("http", "send_request", { url }), /Method/);
});

Deno.test("loopback requests, retries, response and error exposure", async () => {
	const requests: string[] = [];
	const server = Deno.serve(
		{ hostname: "127.0.0.1", port: 0, onListen() {} },
		async (request) => {
			requests.push(new URL(request.url).pathname);
			if (new URL(request.url).pathname === "/delay") {
				await new Promise((resolve) => setTimeout(resolve, 150));
				return Response.json({ completed: true });
			}
			if (new URL(request.url).pathname === "/ok") {
				return Response.json({
					authorization: request.headers.get("authorization"),
				});
			}
			return new Response("fixture-response-secret", { status: 503 });
		},
	);
	const base = `http://127.0.0.1:${server.addr.port}`;
	try {
		const success = await invoke("http", "send_request", {
			method: "GET",
			url: `${base}/ok`,
			authType: "BEARER_TOKEN",
			authFields: { token: "fixture-token" },
			failureMode: "retry_none",
		});
		assert.deepEqual(success.body, { authorization: "Bearer fixture-token" });
		for (
			const [failureMode, expected] of [["retry_none", 1], [
				"retry_all",
				3,
			]] as const
		) {
			const before = requests.length;
			let caught: unknown;
			try {
				await invoke("http", "send_request", {
					method: "POST",
					url: `${base}/fail`,
					failureMode,
					timeout: 3,
					body_type: "json",
					body: { data: { secret: "fixture-request-secret" } },
				});
			} catch (error) {
				caught = error;
			}
			assert.ok(caught);
			assert.match(String(caught), /fixture-response-secret/);
			assert.match(String(caught), /fixture-request-secret/);
			assert.equal(requests.length - before, expected);
		}
		const result = await invoke("http", "send_request", {
			method: "POST",
			url: `${base}/fail`,
			failureMode: "continue_all",
			body_type: "json",
			body: { data: { secret: "fixture-request-secret" } },
			timeout: 3,
		});
		assert.deepEqual(result, {
			response: { status: 503, body: "fixture-response-secret" },
			request: { body: { secret: "fixture-request-secret" } },
		});
		const pending = invoke("http", "send_request", {
			method: "GET",
			url: `${base}/delay`,
			failureMode: "retry_none",
			timeout: 3,
		});
		const outer = await Promise.race([
			pending,
			new Promise((resolve) => setTimeout(() => resolve("outer-timeout"), 20)),
		]);
		assert.equal(outer, "outer-timeout");
		const completed = await pending;
		assert.deepEqual(completed.body, { completed: true });
	} finally {
		await server.shutdown();
	}
});
