import { strict as assert } from "node:assert";
import nock from "nock";
import { Host } from "./host.ts";
import { triggers } from "./registry.ts";

nock.disableNetConnect();
const stripeInput = {
	auth: { secret_text: "fixture" },
	propsValue: {},
	webhookUrl: "https://callback.example.test/stripe",
	isRepublish: false,
};
const githubInput = {
	auth: { access_token: "fixture" },
	propsValue: { repository: { owner: "fixture", repo: "demo" } },
	webhookUrl: "https://callback.example.test/github",
	isRepublish: false,
};
async function fixture(fn: (host: Host) => Promise<void>) {
	const dir = await Deno.makeTempDir({ dir: "." });
	const host = new Host(`${dir}/state.json`);
	await host.initialize();
	try {
		await fn(host);
		assert.deepEqual(nock.pendingMocks(), []);
	} finally {
		nock.cleanAll();
		await Deno.remove(dir, { recursive: true });
	}
}
const feed = (ids: number[]) =>
	`<?xml version="1.0"?><rss version="2.0"><channel><title>Fixture</title><link>https://feed.example.test</link><description>Fixture</description>${
		ids.map((id) =>
			`<item><guid>item-${id}</guid><title>Item ${id}</title><link>https://feed.example.test/${id}</link><pubDate>${
				new Date(Date.UTC(2026, 0, id)).toUTCString()
			}</pubDate></item>`
		).join("")
	}</channel></rss>`;
const rssInput = {
	auth: undefined,
	propsValue: { rss_feed_url: "https://feed.example.test/rss" },
	isRepublish: false,
	maxItemsToPoll: 100,
	files: {},
	server: {},
};
const rssReply = (ids: number[]) =>
	nock("https://feed.example.test").get("/rss").reply(200, feed(ids), {
		"Content-Type": "application/rss+xml",
	});

Deno.test("one host executes Stripe and GitHub lifecycle, restores stores, filters and deduplicates ingress", () =>
	fixture(async (host) => {
		nock("https://api.stripe.com").post("/v1/webhook_endpoints").reply(200, {
			id: "we_1",
			secret: "whsec_fixture",
		});
		await host.invoke("stripe", triggers.stripe, "onEnable", stripeInput);
		assert.deepEqual((await host.state()).stores.stripe, {
			_checkout_session_completed_trigger: { webhookId: "we_1" },
		});
		nock("https://api.github.com").post("/repos/fixture/demo/hooks").reply(
			201,
			{ id: 7 },
		);
		await host.invoke("github", triggers.github, "onEnable", githubInput);
		const resumed = new Host(host.file);
		const payload = {
			headers: {},
			body: {
				id: "evt_1",
				data: {
					object: { id: "cs_1", customer: "cus_1", payment_status: "paid" },
				},
			},
		};
		assert.equal(
			(await resumed.invoke("stripe", triggers.stripe, "run", {
				...stripeInput,
				payload,
			}, { receipt: "evt_1" })).length,
			1,
		);
		assert.deepEqual(
			await resumed.invoke("stripe", triggers.stripe, "run", {
				...stripeInput,
				payload,
			}, { receipt: "evt_1" }),
			[],
		);
		assert.deepEqual(
			await resumed.invoke("stripe", triggers.stripe, "run", {
				...stripeInput,
				propsValue: { customer: "different" },
				payload,
			}, { receipt: "evt_2" }),
			[],
		);
		assert.deepEqual(
			await resumed.invoke("github", triggers.github, "run", {
				...githubInput,
				payload: { body: { zen: "ping" } },
			}),
			[],
		);
		assert.equal(
			(await resumed.invoke("github", triggers.github, "run", {
				...githubInput,
				payload: { body: { action: "opened", issue: { id: 1 } } },
			}, { receipt: "delivery_1" })).length,
			1,
		);
		nock("https://api.stripe.com").delete("/v1/webhook_endpoints/we_1").reply(
			200,
			{},
		);
		nock("https://api.github.com").delete("/repos/fixture/demo/hooks/7").reply(
			204,
		);
		await resumed.invoke("stripe", triggers.stripe, "onDisable", stripeInput);
		await resumed.invoke("github", triggers.github, "onDisable", githubInput);
		assert.equal((await resumed.state()).events.length, 2);
	}));

Deno.test("unsigned Stripe payload and unpaid checkout are emitted: lifecycle support is not payment verification", () =>
	fixture(async (host) => {
		const payload = {
			headers: {},
			body: { data: { object: { id: "cs_forged", payment_status: "unpaid" } } },
		};
		const result = await host.invoke("stripe", triggers.stripe, "run", {
			...stripeInput,
			payload,
		});
		assert.deepEqual(result, [{ id: "cs_forged", payment_status: "unpaid" }]);
	}));

Deno.test("RSS checkpoint and outbox commit together, survive restart and retain republish cursor", () =>
	fixture(async (host) => {
		rssReply([1]);
		await host.invoke("rss", triggers.rss, "onEnable", rssInput);
		const before = await host.state();
		rssReply([2, 1]);
		await assert.rejects(
			() =>
				host.invoke("rss", triggers.rss, "run", rssInput, {
					failBeforeCommit: true,
				}),
			/Injected commit failure/,
		);
		assert.deepEqual(await host.state(), before);
		const resumed = new Host(host.file);
		rssReply([2, 1]);
		assert.equal(
			(await resumed.invoke("rss", triggers.rss, "run", rssInput)).length,
			1,
		);
		await resumed.invoke("rss", triggers.rss, "onDisable", {
			...rssInput,
			isRepublish: true,
		});
		await resumed.invoke("rss", triggers.rss, "onEnable", {
			...rssInput,
			isRepublish: true,
		});
		rssReply([2, 1]);
		assert.deepEqual(
			await resumed.invoke("rss", triggers.rss, "run", rssInput),
			[],
		);
		rssReply([3, 2, 1]);
		assert.equal(
			(await resumed.invoke("rss", triggers.rss, "run", rssInput)).length,
			1,
		);
		assert.equal((await resumed.state()).events.length, 2);
	}));

Deno.test("external webhook registration cannot be rolled back with the local store", () =>
	fixture(async (host) => {
		let registrations = 0;
		nock("https://api.stripe.com").post("/v1/webhook_endpoints").twice().reply(
			() => [200, { id: `we_${++registrations}`, secret: "whsec_fixture" }],
		);
		await assert.rejects(
			() =>
				host.invoke("stripe", triggers.stripe, "onEnable", stripeInput, {
					failBeforeCommit: true,
				}),
			/Injected commit failure/,
		);
		await new Host(host.file).invoke(
			"stripe",
			triggers.stripe,
			"onEnable",
			stripeInput,
		);
		assert.equal(registrations, 2);
		assert.deepEqual((await host.state()).stores.stripe, {
			_checkout_session_completed_trigger: { webhookId: "we_2" },
		});
	}));

Deno.test("eager store writes lose RSS event when delivery fails after trigger returns", () =>
	fixture(async (host) => {
		rssReply([1]);
		await host.invoke("rss", triggers.rss, "onEnable", rssInput);
		const state = await host.state();
		const data = state.stores.rss;
		const eagerContext = {
			...rssInput,
			store: {
				get: (key: string) => Promise.resolve(data[key] ?? null),
				put: async (key: string, value: unknown) => {
					data[key] = value;
					await Deno.writeTextFile(host.file, JSON.stringify(state));
				},
				delete: async (key: string) => {
					delete data[key];
					await Deno.writeTextFile(host.file, JSON.stringify(state));
				},
			},
		};
		rssReply([2, 1]);
		const lost = await triggers.rss.run(eagerContext);
		assert.equal(lost.length, 1);
		// Drop output to model a crash after eager checkpoint persistence.
		rssReply([2, 1]);
		assert.deepEqual(
			await new Host(host.file).invoke("rss", triggers.rss, "run", rssInput),
			[],
		);
		assert.deepEqual((await host.state()).events, []);
	}));

Deno.test("GitHub registers no signature secret and emits unsigned callback bodies", () =>
	fixture(async (host) => {
		nock("https://api.github.com").post("/repos/fixture/demo/hooks", (body) => {
			assert.equal(body.config.secret, undefined);
			return true;
		}).reply(201, { id: 9 });
		await host.invoke("github", triggers.github, "onEnable", githubInput);
		const forged = { action: "opened", issue: { id: 44 } };
		assert.deepEqual(
			await host.invoke("github", triggers.github, "run", {
				...githubInput,
				payload: { headers: {}, body: forged },
			}),
			[forged],
		);
	}));
