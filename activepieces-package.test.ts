import {
	assertEquals,
	assertNotEquals,
	assertRejects,
	assertStringIncludes,
} from "@std/assert";
import { type Declaration, packageHatch } from "./activepieces-package.ts";

const decoder = new TextDecoder();
async function fixture(): Promise<{ dir: string; declaration: Declaration }> {
	const dir = await Deno.makeTempDir();
	await Deno.mkdir(`${dir}/pieces/mail`, { recursive: true });
	await Deno.writeTextFile(
		`${dir}/pieces/mail/package.json`,
		JSON.stringify({
			exports: "./index.js",
			dependencies: { example: "1.2.3" },
		}),
	);
	await Deno.writeTextFile(
		`${dir}/pieces/mail/index.js`,
		"export const mail = {};\n",
	);
	await Deno.writeFile(
		`${dir}/pieces/mail/logo.bin`,
		new Uint8Array([0, 255, 128, 10]),
	);
	for (const schema of ["send.input", "send.output", "mail.auth"]) {
		await Deno.writeTextFile(
			`${dir}/pieces/mail/${schema}.schema.json`,
			JSON.stringify({ type: "object" }),
		);
	}
	await Deno.writeTextFile(
		`${dir}/pieces/integrations.lock`,
		'{"version":"5"}\n',
	);
	return {
		dir,
		declaration: {
			version: 1,
			lock: "./pieces/integrations.lock",
			pieces: { mail: { local: "./pieces/mail", export: "mail" } },
			actions: {
				sendMail: {
					piece: "mail",
					action: "send-mail",
					inputSchema: "./pieces/mail/send.input.schema.json",
					outputSchema: "./pieces/mail/send.output.schema.json",
					auth: {
						jsonSecret: "SMTP_AUTH_JSON",
						schema: "./pieces/mail/mail.auth.schema.json",
					},
					fixedProps: { host: "example.test" },
				},
			},
			limits: {
				timeoutMs: 8000,
				maxConcurrent: 4,
				maxRequestBytes: 1048576,
				maxResultBytes: 1048576,
			},
		},
	};
}

Deno.test("package snapshots binary assets, pinned dependencies and reviewed schemas into a revision", async () => {
	const { dir, declaration } = await fixture();
	try {
		const first = await packageHatch(dir, declaration);
		assertEquals(
			first.get("pieces/mail/logo.bin"),
			new Uint8Array([0, 255, 128, 10]),
		);
		const manifest = JSON.parse(decoder.decode(first.get("manifest.json")));
		assertEquals(manifest.actions.sendMail.inputSchema, { type: "object" });
		assertEquals(manifest.actions.sendMail.auth, {
			jsonSecret: "SMTP_AUTH_JSON",
			schema: { type: "object" },
		});
		assertEquals(
			JSON.parse(decoder.decode(first.get("deno.json")))
				.scopes["./pieces/mail/"].example,
			"npm:example@1.2.3",
		);
		assertStringIncludes(
			decoder.decode(first.get("registry.ts")),
			'from "./pieces/mail/index.js"',
		);
		assertEquals(decoder.decode(first.get("deno.lock")), '{"version":"5"}\n');
		await Deno.writeFile(
			`${dir}/pieces/mail/logo.bin`,
			new Uint8Array([0, 255, 128, 11]),
		);
		const next = await packageHatch(dir, declaration);
		assertNotEquals(
			JSON.parse(decoder.decode(next.get("manifest.json"))).revision,
			manifest.revision,
		);
	} finally {
		await Deno.remove(dir, { recursive: true });
	}
});

Deno.test("package rejects escaping closures, symlinks, unsafe dependencies and remote schema references", async () => {
	const { dir, declaration } = await fixture();
	try {
		await assertRejects(
			() =>
				packageHatch(dir, {
					...declaration,
					pieces: { mail: { local: "../mail", export: "mail" } },
				}),
			Error,
			"Unsafe piece path",
		);
		await Deno.symlink(
			`${dir}/pieces/integrations.lock`,
			`${dir}/pieces/mail/link`,
		);
		await assertRejects(() => packageHatch(dir, declaration), Error, "Symlink");
		await Deno.remove(`${dir}/pieces/mail/link`);
		await Deno.writeTextFile(
			`${dir}/pieces/mail/package.json`,
			JSON.stringify({
				exports: "./index.js",
				dependencies: { example: "file:../other" },
			}),
		);
		await assertRejects(
			() => packageHatch(dir, declaration),
			Error,
			"pin an exact npm version",
		);
		await Deno.writeTextFile(
			`${dir}/pieces/mail/package.json`,
			JSON.stringify({ exports: "./index.js" }),
		);
		await Deno.writeTextFile(
			`${dir}/pieces/mail/send.input.schema.json`,
			JSON.stringify({ $ref: "https://example.test/schema" }),
		);
		await assertRejects(
			() => packageHatch(dir, declaration),
			Error,
			"fragment references",
		);
	} finally {
		await Deno.remove(dir, { recursive: true });
	}
});
