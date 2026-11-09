import { assertEquals, assertStringIncludes } from "@std/assert";
import type { Declaration } from "./activepieces-package.ts";
import { cue, emitFiles, paymentProgram } from "./effects-fixtures.ts";

const declaration = `
app: capabilities: hatches: smtp: {
 kind: "container", note: "trusted integration"
 activepieces: {
  lock: "./pieces/integrations.lock"
  pieces: mail: {local: "./pieces/mail", export: "mail"}
  actions: sendMail: {
   piece: "mail", action: "send-mail"
   inputSchema: "./pieces/mail/send.input.schema.json"
   outputSchema: "./pieces/mail/send.output.schema.json"
   auth: {jsonSecret: "SMTP_AUTH_JSON", schema: "./pieces/mail/mail.auth.schema.json"}
   fixedProps: {host: "smtp.example.test"}
   idempotencyKeyProp: "requestKey"
  }
 }
}
`;
const program = (
	d = declaration,
	bridge = '{container: "smtp", action: "sendMail"}',
) =>
	paymentProgram().replace(
		'sink: {origin: "https://api.acquirer.example", idempotent: true}',
		'sink: {bridge: "mail", idempotent: false}\n      reentry: "unknown"',
	) +
	`\napp: state: bridges: mail: ${bridge}\n` + d;

Deno.test("Activepieces declarations emit paths and action-scoped binding", async () => {
	const files = await emitFiles(program());
	const descriptor =
		(files["activepieces/smtp/declaration.json"] as unknown as {
			data: Declaration;
		}).data;
	assertEquals(descriptor.version, 1);
	assertEquals(descriptor.limits, {
		timeoutMs: 8000,
		maxConcurrent: 4,
		maxRequestBytes: 1048576,
		maxResultBytes: 1048576,
	});
	assertEquals(
		descriptor.actions.sendMail.inputSchema,
		"./pieces/mail/send.input.schema.json",
	);
	assertEquals(
		(files["services/airlock/dapr/charge.yaml"] as unknown as {
			data: { spec: { baseUrl: string } };
		}).data.spec.baseUrl,
		"http://smtp:8080/actions/sendMail",
	);
	const env = await cue(["export", "-", "-e", '_cluster.surface.targets["airlock-mesh"].compose.environment.BRIDGE_MAIL_URL', "--out", "json"], program());
	assertEquals(env.success, true, env.stderr);
	assertEquals(JSON.parse(env.stdout), "http://smtp:8080/actions/sendMail");
});

Deno.test("Activepieces declarations refuse invalid admission and routing", async () => {
	const variants = [
		declaration.replace('piece: "mail", action', 'piece: "absent", action'),
		declaration.replace(
			'idempotencyKeyProp: "requestKey"',
			'idempotencyKeyProp: "host"',
		),
		declaration.replace('./pieces/mail"', '../pieces/mail"'),
		declaration.replace(
			"./pieces/mail/send.input.schema.json",
			"./pieces/../send.input.schema.json",
		),
		declaration.replace("SMTP_AUTH_JSON", "DATABASE_URL"),
		declaration.replace(
			'lock: "./pieces/integrations.lock"',
			'lock: "./pieces/../integrations.lock"',
		),
		declaration.replace('lock: "./pieces/integrations.lock"', ""),
		declaration.replace(
			'jsonSecret: "SMTP_AUTH_JSON",',
			'jsonSecret: "SMTP_AUTH_JSON", value: "secret",',
		),
		declaration.replace(
			'local: "./pieces/mail", export: "mail"',
			'npm: {package: "@vendor/piece-mail", version: "^1.2.3", export: "mail"}',
		),
		declaration.replace(
			"pieces: mail:",
			"limits: timeoutMs: 9000\n  pieces: mail:",
		),
		declaration.replace(
			"fixedProps: {host:",
			"override: true\n   fixedProps: {host:",
		),
		declaration.replace('kind: "container"', 'kind: "sql", files: ["a.sql"]'),
	];
	for (const d of variants) {
		const result = await cue(["export", "-", "-e", "out"], program(d));
		assertEquals(result.success, false, d);
	}
	for (
		const bridge of [
			'{container: "smtp"}',
			'{container: "smtp", action: "other"}',
			'{container: "smtp", action: "sendMail", port: 8081}',
		]
	) {
		const result = await cue(
			["export", "-", "-e", "out"],
			program(declaration, bridge),
		);
		assertEquals(result.success, false, bridge);
	}
	const cluster = await cue([
		"export",
		"-",
		"-e",
		"_cluster.surface.targets.smtp",
		"--out",
		"json",
	], program());
	assertEquals(cluster.success, true, cluster.stderr);
	const target = JSON.parse(cluster.stdout);
	assertEquals(
		target.dockerfile.from.ref,
		"libraries_mecha:activepieces-image",
	);
	assertEquals(
		target.compose.environment.SMTP_AUTH_JSON,
		"${SMTP_AUTH_JSON:?SMTP_AUTH_JSON is required by the integration hatch}",
	);
	const npm = declaration.replace(
		'local: "./pieces/mail", export: "mail"',
		'npm: {package: "@vendor/piece-mail", version: "1.2.3", export: "mail"}',
	);
	assertEquals(
		(await cue(["export", "-", "-e", "out"], program(npm))).success,
		true,
	);
	const generic = program(
		declaration.replace(/ activepieces: \{[\s\S]*\n \}\n\}/, "}"),
	);
	const result = await cue(["export", "-", "-e", "out"], generic);
	assertEquals(result.success, false);
	assertStringIncludes(result.stderr, "non-Activepieces hatch");
});
