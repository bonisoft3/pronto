import { fileURLToPath } from "node:url";
import { ifMissing } from "../missing.ts";
import {
	duckdbExpression,
	type Field,
	parse,
	parseDeclaredType,
	parseProgram,
	quote,
	type Relation,
	require,
	type Schema,
	translate,
	type,
	validateProgramViews,
} from "./translator.ts";

export const compiler = {
	engine: "duckdb",
	version: "1.5.6",
} as const;

export interface CompileOptions {
	sourcePath: string;
	outputDirectory: string;
	view?: string;
}
export interface ProgramOptions extends Omit<CompileOptions, "view"> {
	views: string[];
}

const prontoRoot = fileURLToPath(new URL("..", import.meta.url));

export async function sha256(bytes: Uint8Array): Promise<string> {
	return Array.from(
		new Uint8Array(
			await crypto.subtle.digest("SHA-256", new Uint8Array(bytes)),
		),
		(byte) => byte.toString(16).padStart(2, "0"),
	).join("");
}

export async function currentCompilerHashes(): Promise<Record<string, string>> {
	const hashes: Record<string, string> = {};
	for (
		const [name, path] of Object.entries({
			translator: "translator.ts",
			driver: "compiler.ts",
		})
	) {
		hashes[name] = await sha256(
			await Deno.readFile(new URL(path, import.meta.url)),
		);
	}
	return hashes;
}

interface IntrospectedColumn {
	version: string;
	table_name: string;
	column_name: string;
	data_type: string;
	is_nullable: string;
	numeric_precision: number | null;
	numeric_scale: number | null;
}

async function runDuckdbJson(sql: string): Promise<IntrospectedColumn[]> {
	let bin = "mise";
	if (Deno.build.os === "windows") {
		const localAppData = Deno.env.get("LOCALAPPDATA");
		require(Boolean(localAppData), "LOCALAPPDATA is required on Windows");
		bin = `${localAppData}\\mise\\bin\\mise.exe`;
	}
	const child = new Deno.Command(bin, {
		args: ["x", "--", "duckdb", "-dark-mode", "-batch", "-json", ":memory:"],
		cwd: prontoRoot,
		stdin: "piped",
		stdout: "piped",
		stderr: "piped",
	}).spawn();
	const outPromise = child.output();
	let writeError: unknown = null;
	try {
		const writer = child.stdin.getWriter();
		await writer.write(new TextEncoder().encode(sql));
		await writer.close();
	} catch (error) {
		writeError = error;
	}
	const out = await outPromise;
	const stderr = new TextDecoder().decode(out.stderr).trim();
	const stdout = new TextDecoder().decode(out.stdout).trim();
	require(out.success, `duckdb exited ${out.code}\n${stdout}\n${stderr}`);
	if (writeError !== null) throw writeError;
	return stdout ? (JSON.parse(stdout) as IntrospectedColumn[]) : [];
}

function columnField(row: IntrospectedColumn): Field {
	const nullable = row.is_nullable !== "NO";
	const dt = row.data_type.toUpperCase();
	if (dt.startsWith("DECIMAL(") || dt.startsWith("NUMERIC(")) {
		const parsed = parseDeclaredType(dt);
		return {
			name: row.column_name,
			case_sensitive: row.column_name !== row.column_name.toLowerCase(),
			columntype: { ...parsed, nullable },
			unused: false,
		};
	}
	if (dt === "DECIMAL" || dt === "NUMERIC") {
		require(
			row.numeric_precision !== null && row.numeric_scale !== null,
			"DECIMAL precision and scale",
		);
		const colType = {
			nullable,
			precision: row.numeric_precision,
			scale: row.numeric_scale,
			type: "DECIMAL",
		};
		type(colType);
		return {
			name: row.column_name,
			case_sensitive: row.column_name !== row.column_name.toLowerCase(),
			columntype: colType,
			unused: false,
		};
	}
	const parsed = parseDeclaredType(dt === "TIMESTAMP" ? "TIMESTAMP(6)" : dt);
	return {
		name: row.column_name,
		case_sensitive: row.column_name !== row.column_name.toLowerCase(),
		columntype: { ...parsed, nullable },
		unused: false,
	};
}

async function runCompiler(directory: string, source: string) {
	const sourceSql = await Deno.readTextFile(source);
	const program = parseProgram(sourceSql);
	validateProgramViews(program);
	const ddl: string[] = [];
	for (const input of program.inputs) {
		const cols = input.fields.map((f) =>
			`${quote(f.name)} ${type(f.columntype)}${
				f.columntype.nullable ? "" : " NOT NULL"
			}`
		).join(", ");
		ddl.push(`CREATE TABLE ${quote(input.name)} (${cols});`);
	}
	for (const view of program.views) {
		ddl.push(
			`CREATE VIEW ${quote(view.name)} AS ${duckdbExpression(view.body)};`,
		);
	}
	ddl.push(
		`SELECT version() AS version, c.table_name, c.column_name, c.data_type, c.is_nullable, c.numeric_precision, c.numeric_scale ` +
			`FROM (SELECT 1) v LEFT JOIN information_schema.columns c ON c.table_schema = 'main' ` +
			`ORDER BY c.table_name, c.ordinal_position;`,
	);
	const rows = await runDuckdbJson(ddl.join("\n"));
	require(rows.length > 0, "duckdb version check");
	require(
		rows[0].version === `v${compiler.version}`,
		`expected duckdb v${compiler.version}, got ${rows[0].version}`,
	);
	const byView = new Map<string, Field[]>();
	for (const row of rows) {
		if (!row.table_name) continue;
		const key = row.table_name.toLowerCase();
		let list = byView.get(key);
		if (!list) {
			list = [];
			byView.set(key, list);
		}
		list.push(columnField(row));
	}
	const outputs: Relation[] = program.views.map((view) => {
		const fields = byView.get(view.name.toLowerCase());
		require(
			fields && fields.length > 0,
			`missing columns for view ${view.name}`,
		);
		return {
			name: view.name,
			case_sensitive: false,
			fields,
			materialized: view.materialized,
			foreign_keys: [],
		};
	});
	const schema: Schema = { inputs: program.inputs, outputs };
	await Deno.writeTextFile(
		`${directory}/schema.json`,
		JSON.stringify(schema, null, 2) + "\n",
	);
}

async function artifacts(options: ProgramOptions) {
	const directory = await Deno.realPath(options.outputDirectory);
	const sourceBytes = await Deno.readFile(options.sourcePath);
	const sourceSql = new TextDecoder().decode(sourceBytes);
	const schemaText = await Deno.readTextFile(`${directory}/schema.json`);
	const schema = parse(schemaText) as Schema;
	require(
		options.views.length > 0 &&
			new Set(options.views).size === options.views.length,
		"distinct output views",
	);
	const queries: Record<string, string> = {};
	for (const view of options.views) {
		require(
			/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(view),
			"output filename identifier",
		);
		queries[view] = translate(sourceSql, schema, view);
	}
	const files: Record<string, Uint8Array> = {
		source: sourceBytes,
		schema: new TextEncoder().encode(schemaText),
	};
	for (const [view, sql] of Object.entries(queries)) {
		files[`${view}.sql`] = new TextEncoder().encode(sql);
	}
	const hashes = await currentCompilerHashes();
	for (const [name, bytes] of Object.entries(files)) {
		hashes[name] = await sha256(bytes);
	}
	return {
		source: sourceSql,
		queries,
		schema,
		manifest: { format: 2, compiler, views: options.views, hashes },
	};
}

export async function compiledFrom(directory: string, source: string) {
	const text = await ifMissing(
		Deno.readTextFile(`${directory}/manifest.json`),
		null,
	);
	if (text === null) return false;
	let manifest: { format?: unknown; compiler?: unknown; hashes?: unknown };
	try {
		manifest = JSON.parse(text);
	} catch (e) {
		if (e instanceof SyntaxError) return false;
		throw e;
	}
	if (
		manifest === null || typeof manifest !== "object" ||
		manifest.format !== 2 || manifest.hashes === null ||
		typeof manifest.hashes !== "object"
	) return false;
	const hashes = manifest.hashes as Record<string, unknown>;
	if (JSON.stringify(manifest.compiler) !== JSON.stringify(compiler)) {
		return false;
	}
	for (const [name, hash] of Object.entries(await currentCompilerHashes())) {
		if (hashes[name] !== hash) return false;
	}
	if (hashes.source !== await sha256(await Deno.readFile(source))) {
		return false;
	}
	const schemaBytes = await ifMissing(
		Deno.readFile(`${directory}/schema.json`),
		null,
	);
	if (schemaBytes === null || hashes.schema !== await sha256(schemaBytes)) {
		return false;
	}
	return true;
}

export async function compileProgram(options: ProgramOptions) {
	await Deno.mkdir(options.outputDirectory, { recursive: true });
	const directory = await Deno.realPath(options.outputDirectory);
	const source = await Deno.realPath(options.sourcePath);
	if (!(await compiledFrom(directory, source))) {
		await runCompiler(directory, source);
	}
	const result = await artifacts(options);
	for (const [view, sql] of Object.entries(result.queries)) {
		await Deno.writeTextFile(`${directory}/${view}.sql`, sql);
	}
	await Deno.writeTextFile(
		`${directory}/manifest.json`,
		JSON.stringify(result.manifest, null, 2) + "\n",
	);
	return result;
}

export async function checkCompiledProgram(options: ProgramOptions) {
	const result = await artifacts(options);
	const directory = await Deno.realPath(options.outputDirectory);
	const manifest = JSON.parse(
		await Deno.readTextFile(`${directory}/manifest.json`),
	);
	require(
		JSON.stringify(manifest) === JSON.stringify(result.manifest),
		"stale compiled SQL provenance; regenerate",
	);
	for (const [view, sql] of Object.entries(result.queries)) {
		require(
			await Deno.readTextFile(`${directory}/${view}.sql`) === sql,
			"stale generated DuckDB SQL; regenerate",
		);
	}
	return result;
}

export async function compileSql(options: CompileOptions) {
	const view = options.view ?? "result";
	const result = await compileProgram({ ...options, views: [view] });
	return { ...result, sql: result.queries[view] };
}

export async function checkCompiledSql(options: CompileOptions) {
	const view = options.view ?? "result";
	const result = await checkCompiledProgram({ ...options, views: [view] });
	return { ...result, sql: result.queries[view] };
}
