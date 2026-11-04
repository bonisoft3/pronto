import { strict as assert } from "node:assert";
import {
	type Declaration,
	packageHatch,
	writePackage,
} from "./activepieces-package.ts";

function stop(child: Deno.ChildProcess) {
	try {
		child.kill("SIGKILL");
	} catch (error) {
		if (
			!(error instanceof TypeError &&
				error.message === "Child process has already terminated")
		) throw error;
	}
}

Deno.test("generated npm registry runs a published action through the supervisor", async () => {
	const fixture = new URL("./testdata/activepieces/", import.meta.url).pathname;
	const runner =
		new URL("../../libraries/mecha/services/activepieces/", import.meta.url)
			.pathname;
	const temp = await Deno.makeTempDir();
	let child: Deno.ChildProcess | undefined;
	try {
		const declaration: Declaration = JSON.parse(
			await Deno.readTextFile(`${fixture}declaration.json`),
		);
		await writePackage(temp, await packageHatch(fixture, declaration));
		const info = await new Deno.Command(Deno.execPath(), {
			args: ["info", "--json"],
			stdout: "piped",
			stderr: "piped",
		}).output();
		assert.deepEqual(info.success, true);
		const denoDir: string =
			JSON.parse(new TextDecoder().decode(info.stdout)).denoDir;
		// The runner starts --cached-only, and a fresh machine holds neither graph.
		for (
			const [config, entry] of [
				[`${temp}/deno.json`, `${temp}/registry.ts`],
				[`${runner}deno.json`, `${runner}main.ts`],
			]
		) {
			const cache = await new Deno.Command(Deno.execPath(), {
				args: ["cache", "--frozen", `--config=${config}`, entry],
				env: { DENO_DIR: denoDir },
				stdout: "null",
				stderr: "piped",
			}).output();
			assert.deepEqual(
				cache.success,
				true,
				new TextDecoder().decode(cache.stderr),
			);
		}
		const socket = Deno.listen({ hostname: "127.0.0.1", port: 0 });
		const port = (socket.addr as Deno.NetAddr).port;
		socket.close();
		child = new Deno.Command(Deno.execPath(), {
			args: [
				"run",
				"--frozen",
				"--cached-only",
				`--config=${runner}deno.json`,
				"--allow-env",
				"--allow-read",
				"--allow-net",
				"--allow-run",
				`${runner}main.ts`,
			],
			env: {
				DENO_DIR: denoDir,
				ACTIVEPIECES_MANIFEST: `${temp}/manifest.json`,
				ACTIVEPIECES_REGISTRY: `${temp}/registry.ts`,
				PORT: String(port),
			},
			stdout: "null",
			stderr: "null",
		}).spawn();
		const base = `http://127.0.0.1:${port}`;
		let ready = false;
		for (let i = 0; i < 100; i++) {
			try {
				await fetch(`${base}/ready`);
				ready = true;
				break;
			} catch (error) {
				if (!(error instanceof TypeError)) throw error;
				await new Promise((resolve) => setTimeout(resolve, 50));
			}
		}
		assert.deepEqual(ready, true, "runner did not become ready");
		const post = (path: string, props: unknown) =>
			fetch(`${base}${path}`, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					"Idempotency-Key": "fixture-key",
				},
				body: JSON.stringify({ props }),
			});
		const response = await post("/actions/parse/", {
			url: "https://example.test/?a=1&a=2",
		});
		assert.deepEqual(response.status, 200);
		const body = await response.json();
		assert.ok(body.result);
		assert.deepEqual(body.result.query_parameters, { a: ["1", "2"] });
		assert.deepEqual(
			(await post("/actions/other/", { url: "https://example.test" })).status,
			404,
		);
		assert.deepEqual(
			(await post("/actions/parse/", {
				url: "https://example.test",
				returnArrays: false,
			})).status,
			400,
		);
	} finally {
		if (child) {
			stop(child);
			await child.status;
		}
		await Deno.remove(temp, { recursive: true });
	}
});
