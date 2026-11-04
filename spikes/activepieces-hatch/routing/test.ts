import assert from "node:assert/strict";

const image =
	"daprio/daprd:1.16.1@sha256:b977660c4503fe9872b0a94a33067df0dfe0a84878dc054acd8caff82a8c4125";
async function docker(...args: string[]) {
	const result = await new Deno.Command("docker", {
		args,
		stdout: "piped",
		stderr: "piped",
	}).output();
	if (!result.success) throw new Error(new TextDecoder().decode(result.stderr));
	return new TextDecoder().decode(result.stdout).trim();
}

Deno.test("Dapr binding base path scopes the handler's action route", async () => {
	const paths: string[] = [];
	const server = Deno.serve(
		{ hostname: "0.0.0.0", port: 0, onListen() {} },
		(request) => {
			const path = new URL(request.url).pathname;
			paths.push(path);
			return Response.json({ path }, {
				status: path === "/actions/sendMail/" ? 200 : 404,
			});
		},
	);
	const directory = await Deno.makeTempDir();
	const name = `activepieces-route-${crypto.randomUUID().slice(0, 8)}`;
	let started = false;
	try {
		await Deno.writeTextFile(
			`${directory}/mail.yaml`,
			JSON.stringify({
				apiVersion: "dapr.io/v1alpha1",
				kind: "Component",
				metadata: { name: "mail" },
				spec: {
					type: "bindings.http",
					version: "v1",
					metadata: [
						{
							name: "url",
							value:
								`http://host.docker.internal:${server.addr.port}/actions/sendMail`,
						},
						{ name: "errorIfNot2XX", value: "false" },
					],
				},
			}),
		);
		started = true;
		await docker(
			"run",
			"-d",
			"--name",
			name,
			"--add-host",
			"host.docker.internal:host-gateway",
			"-p",
			"127.0.0.1::3500",
			"-v",
			`${directory}:/components:ro`,
			image,
			"/daprd",
			"--app-id",
			"route-spike",
			"--resources-path",
			"/components",
			"--log-level",
			"error",
		);
		started = true;
		const port = (await docker("port", name, "3500")).split(":").pop();
		const base = `http://127.0.0.1:${port}`;
		let ready = false;
		for (let attempt = 0; attempt < 100; attempt++) {
			try {
				const response = await fetch(`${base}/v1.0/healthz/outbound`);
				await response.body?.cancel();
				if (response.ok) {
					ready = true;
					break;
				}
			} catch (error) {
				if (!(error instanceof TypeError)) throw error;
			}
			await new Promise((resolve) => setTimeout(resolve, 100));
		}
		assert.ok(ready, await docker("logs", name));
		for (const path of ["/", "/other"]) {
			const response = await fetch(`${base}/v1.0/bindings/mail`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					operation: "post",
					data: {},
					metadata: { path },
				}),
			});
			assert.equal(response.status, 200, await response.clone().text());
			assert.equal(
				response.headers.get("metadata.statuscode"),
				path === "/" ? "200" : "404",
			);
			await response.body?.cancel();
		}
		assert.deepEqual(paths, ["/actions/sendMail/", "/actions/sendMail/other"]);
	} finally {
		if (started) await docker("rm", "-f", name);
		await server.shutdown();
		await Deno.remove(directory, { recursive: true });
	}
});
