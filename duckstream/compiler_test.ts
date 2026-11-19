import { assertEquals, assertRejects } from "@std/assert";
import {
	checkCompiledProgram,
	compiledFrom,
	compileProgram,
	compiler,
	currentCompilerHashes,
	sha256,
} from "./compiler.ts";
import { translatePhysical } from "./translator.ts";

const encode = (text: string) => new TextEncoder().encode(text);

function scratchTest(name: string, fn: (directory: string) => Promise<void>) {
	Deno.test(name, async () => {
		const directory = await Deno.makeTempDir();
		try {
			await fn(directory);
		} finally {
			await Deno.remove(directory, { recursive: true });
		}
	});
}

async function compiled(directory: string) {
	const source = `${directory}/program.sql`;
	await Deno.writeTextFile(
		source,
		"CREATE TABLE source_item(id VARCHAR, amount INTEGER);\n" +
			"CREATE MATERIALIZED VIEW v AS SELECT id, amount FROM source_item;\n",
	);
	const schemaText =
		`{"inputs":[{"name":"source_item","fields":[{"name":"id","columntype":{"nullable":true,"precision":-1,"type":"VARCHAR"}},{"name":"amount","columntype":{"nullable":true,"type":"INTEGER"}}],"materialized":false}],"outputs":[{"name":"v","fields":[{"name":"id","columntype":{"nullable":true,"precision":-1,"type":"VARCHAR"}},{"name":"amount","columntype":{"nullable":true,"type":"INTEGER"}}],"materialized":true}]}\n`;
	await Deno.writeTextFile(`${directory}/schema.json`, schemaText);
	const hashes: Record<string, string> = {
		...(await currentCompilerHashes()),
		source: await sha256(await Deno.readFile(source)),
		schema: await sha256(encode(schemaText)),
	};
	const manifest = { format: 2, compiler, views: ["v"], hashes };
	await rewrite(directory, manifest);
	return { source, manifest };
}

const rewrite = (directory: string, manifest: unknown) =>
	Deno.writeTextFile(`${directory}/manifest.json`, JSON.stringify(manifest));

scratchTest(
	"the compiler's output for this source and compiler is reused",
	async (directory) => {
		const { source } = await compiled(directory);
		assertEquals(await compiledFrom(directory, source), true);
	},
);

scratchTest("an edited source compiles again", async (directory) => {
	const { source } = await compiled(directory);
	await Deno.writeTextFile(
		source,
		"CREATE TABLE source_item(id VARCHAR);\nCREATE MATERIALIZED VIEW v AS SELECT id FROM source_item;\n",
	);
	assertEquals(await compiledFrom(directory, source), false);
});

scratchTest("another compiler compiles again", async (directory) => {
	const { source, manifest } = await compiled(directory);
	await rewrite(directory, {
		...manifest,
		compiler: { ...compiler, version: "0.0.0" },
	});
	assertEquals(await compiledFrom(directory, source), false);
});

for (const name of ["translator", "driver"]) {
	scratchTest(`another ${name} compiles again`, async (directory) => {
		const { source, manifest } = await compiled(directory);
		await rewrite(directory, {
			...manifest,
			hashes: { ...manifest.hashes, [name]: "0".repeat(64) },
		});
		assertEquals(await compiledFrom(directory, source), false);
	});
}

scratchTest(
	"an output edited or removed since the compile compiles again",
	async (directory) => {
		const { source } = await compiled(directory);
		await Deno.writeTextFile(`${directory}/schema.json`, "{}\n");
		assertEquals(await compiledFrom(directory, source), false);
		await compiled(directory);
		await Deno.remove(`${directory}/schema.json`);
		assertEquals(await compiledFrom(directory, source), false);
	},
);

scratchTest(
	"a manifest of another format compiles again",
	async (directory) => {
		const { source, manifest } = await compiled(directory);
		await rewrite(directory, { ...manifest, format: 1 });
		assertEquals(await compiledFrom(directory, source), false);
		await rewrite(directory, {});
		assertEquals(await compiledFrom(directory, source), false);
		await rewrite(directory, { ...manifest, hashes: undefined });
		assertEquals(await compiledFrom(directory, source), false);
		const text = JSON.stringify(manifest);
		for (
			const broken of [
				text.slice(0, 40),
				`<<<<<<< HEAD\n${text}`,
			]
		) {
			await Deno.writeTextFile(`${directory}/manifest.json`, broken);
			assertEquals(await compiledFrom(directory, source), false);
		}
	},
);

scratchTest("a directory never compiled compiles", async (directory) => {
	await Deno.writeTextFile(`${directory}/program.sql`, "SELECT 1;\n");
	assertEquals(
		await compiledFrom(directory, `${directory}/program.sql`),
		false,
	);
});

scratchTest(
	"compileProgram introspects DuckDB types, emits CTE and physical queries, and verifies provenance",
	async (directory) => {
		const source = `${directory}/program.sql`;
		await Deno.writeTextFile(
			source,
			[
				"CREATE TABLE source_event(id VARCHAR NOT NULL, ts TIMESTAMP(6) NOT NULL, amount BIGINT NOT NULL);",
				"CREATE LOCAL VIEW positive AS SELECT id, FLOOR(ts TO MONTH) AS bucket, amount / 2 AS half FROM source_event WHERE amount > 0;",
				"CREATE MATERIALIZED VIEW result_totals AS SELECT bucket, COUNT(*) AS n, CAST(SUM(half) AS BIGINT) AS total FROM positive GROUP BY bucket;",
			].join("\n") + "\n",
		);
		const outDir = `${directory}/compiled`;
		const built = await compileProgram({
			sourcePath: source,
			outputDirectory: outDir,
			views: ["result_totals"],
		});
		assertEquals(
			built.schema.outputs[1].fields.map((f) => [f.name, f.columntype.type]),
			[
				["bucket", "TIMESTAMP"],
				["n", "BIGINT"],
				["total", "BIGINT"],
			],
		);
		const checked = await checkCompiledProgram({
			sourcePath: source,
			outputDirectory: outDir,
			views: ["result_totals"],
		});
		assertEquals(checked.queries, built.queries);
		const physical = translatePhysical(
			checked.source,
			checked.schema,
			"result_totals",
			"__duckstream_totals",
		);
		assertEquals(physical.stages.map((s) => s.name), [
			"__duckstream_totals_0",
			"__duckstream_totals_1",
		]);
		await Deno.writeTextFile(`${outDir}/result_totals.sql`, "SELECT 1;\n");
		await assertRejects(
			() =>
				checkCompiledProgram({
					sourcePath: source,
					outputDirectory: outDir,
					views: ["result_totals"],
				}),
			Error,
			"stale generated DuckDB SQL",
		);
	},
);

scratchTest(
	"comma-separated FROM lists and join-like string literals preserve dependencies and literal text",
	async (directory) => {
		const source = `${directory}/program.sql`;
		const literalText =
			"LEFT ASOF JOIN r x MATCH_CONDITION(a >= b) ON a = b -- INTERVAL '7' DAY";
		await Deno.writeTextFile(
			source,
			[
				"CREATE TABLE source_item(id VARCHAR NOT NULL, amount BIGINT NOT NULL);",
				"CREATE LOCAL VIEW positive AS SELECT id, amount FROM source_item WHERE amount > 0;",
				`CREATE MATERIALIZED VIEW result_pairs AS SELECT t.id, positive.amount, '${
					literalText.replaceAll("'", "''")
				}' AS label FROM source_item t, positive WHERE t.id = positive.id;`,
			].join("\n") + "\n",
		);
		const outDir = `${directory}/compiled`;
		const built = await compileProgram({
			sourcePath: source,
			outputDirectory: outDir,
			views: ["result_pairs"],
		});
		assertEquals(
			built.queries.result_pairs.includes(`WITH "positive" AS`),
			true,
		);
		assertEquals(
			built.queries.result_pairs.includes(literalText.replaceAll("'", "''")),
			true,
		);
		const physical = translatePhysical(
			built.source,
			built.schema,
			"result_pairs",
			"__duckstream_pairs",
		);
		assertEquals(physical.stages.length, 2);
		assertEquals(
			physical.stages[1].sql.includes(`"__duckstream_pairs_0" AS "positive"`),
			true,
		);
	},
);

scratchTest(
	"arbitrary timestamp epochs and shadowed CTE names preserve logical and physical parity",
	async (directory) => {
		const source = `${directory}/program.sql`;
		await Deno.writeTextFile(
			source,
			[
				"CREATE TABLE source_event(id VARCHAR NOT NULL, ts TIMESTAMP(6) NOT NULL);",
				"CREATE LOCAL VIEW v AS SELECT 1 AS n, CAST((ts - TIMESTAMP '1970-01-01 00:00:00') SECOND AS BIGINT) AS sec FROM source_event;",
				"CREATE MATERIALIZED VIEW result_shadowed AS WITH v AS (SELECT n + 1 AS n, sec FROM v) SELECT v.n, v.sec FROM (v JOIN source_event s ON s.id = 'e1');",
				"CREATE MATERIALIZED VIEW result_paren_join AS SELECT v.n, v.sec FROM (v JOIN source_event s ON v.sec >= 0 AND s.id = 'e1');",
				"CREATE MATERIALIZED VIEW result_only_cte AS WITH v AS (SELECT 42 AS id) SELECT id FROM v;",
			].join("\n") + "\n",
		);
		const outDir = `${directory}/compiled`;
		const built = await compileProgram({
			sourcePath: source,
			outputDirectory: outDir,
			views: ["result_shadowed", "result_paren_join", "result_only_cte"],
		});
		assertEquals(
			built.queries.result_only_cte.includes(`WITH "v" AS (SELECT 1`),
			false,
		);
		assertEquals(
			built.queries.result_paren_join.includes(`WITH "v" AS (SELECT 1`),
			true,
		);
		const physicalOnly = translatePhysical(
			built.source,
			built.schema,
			"result_only_cte",
			"__duckstream_cte",
		);
		assertEquals(physicalOnly.stages.length, 1);
		const physicalShadowed = translatePhysical(
			built.source,
			built.schema,
			"result_shadowed",
			"__duckstream_shadow",
		);
		assertEquals(physicalShadowed.stages.length, 2);
		const physicalParen = translatePhysical(
			built.source,
			built.schema,
			"result_paren_join",
			"__duckstream_paren",
		);
		assertEquals(physicalParen.stages.length, 2);
		const script = [
			"CREATE TABLE source_event(id VARCHAR NOT NULL, ts TIMESTAMP(6) NOT NULL);",
			"INSERT INTO source_event VALUES ('e1', TIMESTAMP '1970-01-01 00:00:09');",
			...physicalOnly.stages.map((s) =>
				`CREATE TABLE "${s.name}" AS ${s.sql};`
			),
			...physicalShadowed.stages.map((s) =>
				`CREATE TABLE "${s.name}" AS ${s.sql};`
			),
			...physicalParen.stages.map((s) =>
				`CREATE TABLE "${s.name}" AS ${s.sql};`
			),
			`SELECT (SELECT id FROM (${
				built.queries.result_only_cte.replace(/;\s*$/, "")
			})) AS logical_only,`,
			`       (SELECT id FROM (${
				physicalOnly.sql.replace(/;\s*$/, "")
			})) AS physical_only,`,
			`       (SELECT n * 100 + sec FROM (${
				built.queries.result_shadowed.replace(/;\s*$/, "")
			})) AS logical_shadow,`,
			`       (SELECT n * 100 + sec FROM (${
				physicalShadowed.sql.replace(/;\s*$/, "")
			})) AS physical_shadow,`,
			`       (SELECT n * 100 + sec FROM (${
				built.queries.result_paren_join.replace(/;\s*$/, "")
			})) AS logical_paren,`,
			`       (SELECT n * 100 + sec FROM (${
				physicalParen.sql.replace(/;\s*$/, "")
			})) AS physical_paren;`,
		].join("\n");
		const child = new Deno.Command("mise", {
			args: ["x", "--", "duckdb", "-dark-mode", "-batch", "-json", ":memory:"],
			cwd: new URL("..", import.meta.url).pathname,
			stdin: "piped",
			stdout: "piped",
			stderr: "piped",
		}).spawn();
		const writer = child.stdin.getWriter();
		await writer.write(new TextEncoder().encode(script));
		await writer.close();
		const out = await child.output();
		assertEquals(out.success, true, new TextDecoder().decode(out.stderr));
		assertEquals(JSON.parse(new TextDecoder().decode(out.stdout)), [{
			logical_only: 42,
			physical_only: 42,
			logical_shadow: 209,
			physical_shadow: 209,
			logical_paren: 109,
			physical_paren: 109,
		}]);
	},
);

scratchTest(
	"ASOF keyword-suffixed identifiers and trailing line comments compile and execute cleanly",
	async (directory) => {
		const source = `${directory}/program.sql`;
		await Deno.writeTextFile(
			source,
			[
				"CREATE TABLE source_left(id VARCHAR NOT NULL, sort_order BIGINT NOT NULL, ts TIMESTAMP(6) NOT NULL);",
				"CREATE TABLE source_right(sort_order BIGINT NOT NULL, ts TIMESTAMP(6) NOT NULL, val BIGINT NOT NULL);",
				"CREATE LOCAL VIEW joined AS SELECT l.id, r.val FROM source_left l left asof join source_right AS r MATCH_CONDITION(l.ts >= r.ts) ON l.sort_order = r.sort_order -- trailing comment on local view",
				";",
				"CREATE MATERIALIZED VIEW result_asof AS SELECT id, val, '-- kept literal' AS note FROM joined -- trailing comment on output view",
				";",
			].join("\n") + "\n",
		);
		const outDir = `${directory}/compiled`;
		const built = await compileProgram({
			sourcePath: source,
			outputDirectory: outDir,
			views: ["result_asof"],
		});
		assertEquals(
			built.queries.result_asof.includes("l.sort_order = r.sort_order"),
			true,
		);
		assertEquals(
			built.queries.result_asof.includes("'-- kept literal'"),
			true,
		);
	},
);

scratchTest(
	"column comments and differently cased quoted view references resolve consistently",
	async (directory) => {
		const source = `${directory}/program.sql`;
		await Deno.writeTextFile(
			source,
			[
				"CREATE TABLE source_items(",
				"  id /* identifier */ VARCHAR NOT NULL, -- primary key",
				"  n INTEGER /* inline count */ -- trailing comment",
				");",
				'CREATE LOCAL VIEW "Positive" AS SELECT id, n FROM source_items WHERE n > 0;',
				'CREATE MATERIALIZED VIEW result_cased AS SELECT "positive".id, "positive".n FROM "positive";',
			].join("\n") + "\n",
		);
		const outDir = `${directory}/compiled`;
		const built = await compileProgram({
			sourcePath: source,
			outputDirectory: outDir,
			views: ["result_cased"],
		});
		assertEquals(
			built.queries.result_cased.includes(`WITH "Positive" AS`),
			true,
		);
		const physical = translatePhysical(
			built.source,
			built.schema,
			"result_cased",
			"__duckstream_cased",
		);
		assertEquals(physical.stages.length, 2);
		assertEquals(
			physical.stages[1].sql.includes(`"__duckstream_cased_0" AS "positive"`),
			true,
		);
		await Deno.writeTextFile(
			source,
			[
				"CREATE TABLE source_items(id VARCHAR NOT NULL);",
				"CREATE LOCAL VIEW v AS SELECT id FROM source_items;",
				"CREATE MATERIALIZED VIEW result_cased AS SELECT id FROM main.v;",
			].join("\n") + "\n",
		);
		await assertRejects(
			() =>
				compileProgram({
					sourcePath: source,
					outputDirectory: outDir,
					views: ["result_cased"],
				}),
			Error,
			"qualified relation reference",
		);
	},
);

scratchTest(
	"general timestamp differences lower cleanly while nondeterministic expressions are refused",
	async (directory) => {
		const source = `${directory}/program.sql`;
		const outDir = `${directory}/compiled`;
		await Deno.writeTextFile(
			source,
			[
				"CREATE TABLE source_span(id VARCHAR NOT NULL, a TIMESTAMP(6), b TIMESTAMP(6) NOT NULL);",
				"CREATE MATERIALIZED VIEW result_diff AS WITH c1(x) AS (SELECT 1), c2(y) AS (SELECT 2) SELECT id, CAST((COALESCE(a, TIMESTAMP '1970-01-01 00:00:00') - b) SECOND AS INTEGER) + c1.x - c2.y AS diff_int, CAST((b - COALESCE(a, TIMESTAMP '1970-01-01 00:00:00')) SECOND AS BIGINT) AS diff_big FROM source_span, c1, c2;",
			].join("\n") + "\n",
		);
		const built = await compileProgram({
			sourcePath: source,
			outputDirectory: outDir,
			views: ["result_diff"],
		});
		assertEquals(
			built.schema.outputs[0].fields.map((f) => [f.name, f.columntype.type]),
			[
				["id", "VARCHAR"],
				["diff_int", "INTEGER"],
				["diff_big", "BIGINT"],
			],
		);
		for (
			const bad of [
				"SELECT random() AS x FROM source_span",
				"SELECT now() AS x FROM source_span",
				"SELECT CURRENT_TIMESTAMP AS x FROM source_span",
				"SELECT id FROM source_span USING SAMPLE 1 ROWS",
				"SELECT r.x FROM source_span JOIN LATERAL query('SELECT random() AS x') r ON TRUE",
				"SELECT 10 / 0 AS x FROM source_span",
				"SELECT MOD(10, 0) AS x FROM source_span",
				"SELECT SUBSTRING(id FROM 0) AS x FROM source_span",
				"SELECT SUBSTRING(id FROM 1 FOR -1) AS x FROM source_span",
				"SELECT id, CAST(COUNT(*) OVER w AS BIGINT) AS n FROM source_span WINDOW w AS (PARTITION BY id)",
				"SELECT id FROM source_span ORDER BY id LIMIT 1",
				"SELECT DISTINCT ON (id) id FROM source_span",
				"SELECT id FROM source_span WHERE id ~ 'a'",
				"SELECT id FROM source_span WHERE id LIKE 'a%'",
			]
		) {
			await Deno.writeTextFile(
				source,
				`CREATE TABLE source_span(id VARCHAR NOT NULL);\nCREATE MATERIALIZED VIEW result_bad AS ${bad};\n`,
			);
			await assertRejects(
				() =>
					compileProgram({
						sourcePath: source,
						outputDirectory: outDir,
						views: ["result_bad"],
					}),
				Error,
				"OUTSIDE_EXPORT_PROFILE",
			);
		}
		await Deno.writeTextFile(
			source,
			[
				"CREATE TABLE source_sub(s VARCHAR, start_pos INTEGER);",
				"CREATE MATERIALIZED VIEW result_sub AS SELECT SUBSTRING(s FROM start_pos) AS v FROM source_sub;",
			].join("\n") + "\n",
		);
		const subBuilt = await compileProgram({
			sourcePath: source,
			outputDirectory: outDir,
			views: ["result_sub"],
		});
		const runSub = async (insertSql: string) => {
			const child = new Deno.Command("mise", {
				args: [
					"x",
					"--",
					"duckdb",
					"-dark-mode",
					"-batch",
					"-json",
					":memory:",
				],
				cwd: new URL("..", import.meta.url).pathname,
				stdin: "piped",
				stdout: "piped",
				stderr: "piped",
			}).spawn();
			const writer = child.stdin.getWriter();
			await writer.write(
				new TextEncoder().encode(
					`CREATE TABLE source_sub(s VARCHAR, start_pos INTEGER);\n${insertSql}\n${subBuilt.queries.result_sub}`,
				),
			);
			await writer.close();
			return await child.output();
		};
		const nullOut = await runSub(
			"INSERT INTO source_sub VALUES ('abc', NULL);",
		);
		assertEquals(nullOut.success, true);
		assertEquals(JSON.parse(new TextDecoder().decode(nullOut.stdout)), [{
			v: null,
		}]);
		const negOut = await runSub("INSERT INTO source_sub VALUES ('abc', -1);");
		assertEquals(negOut.success, false);
		assertEquals(
			new TextDecoder().decode(negOut.stderr).includes(
				"SUBSTRING bounds outside positive-start/nonnegative-length profile",
			),
			true,
		);
	},
);
