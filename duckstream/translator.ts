export interface Type {
	type: string;
	nullable: boolean;
	precision?: number;
	scale?: number;
}
export interface Field {
	name: string;
	case_sensitive?: boolean;
	columntype: Type;
	unused?: boolean;
}
export interface Relation {
	name: string;
	case_sensitive?: boolean;
	fields: Field[];
	materialized: boolean;
	foreign_keys?: unknown[];
}
export interface Schema {
	inputs: Relation[];
	outputs: Relation[];
}
export interface PhysicalQuery {
	sql: string;
	stages: { name: string; sql: string }[];
}
export interface ParsedView {
	name: string;
	body: string;
	materialized: boolean;
}
export interface ParsedProgram {
	inputs: Relation[];
	views: ParsedView[];
}

export function require(condition: unknown, reason: string): asserts condition {
	if (!condition) throw new Error(`OUTSIDE_EXPORT_PROFILE: ${reason}`);
}

export function parse(text: string): unknown {
	const read = JSON.parse as (
		s: string,
		r: (k: string, v: unknown, c?: { source?: string }) => unknown,
	) => unknown;
	return read(text, (_key, value, context) => {
		if (
			typeof value === "number" && context?.source &&
			/^-?(0|[1-9][0-9]*)$/.test(context.source)
		) {
			require(
				Number.isSafeInteger(value) && BigInt(context.source) === BigInt(value),
				"unsafe JSON integer",
			);
		}
		return value;
	});
}

export function quote(name: string): string {
	return `"${name.replaceAll('"', '""')}"`;
}

export function type(t: Type): string {
	require(
		[
			"INTEGER",
			"BIGINT",
			"BOOLEAN",
			"VARCHAR",
			"TIMESTAMP",
			"DOUBLE",
			"DATE",
			"UUID",
			"DECIMAL",
		].includes(t.type),
		`type ${t.type}`,
	);
	if (t.type === "TIMESTAMP") {
		require(t.precision === 6 || t.precision === undefined, "TIMESTAMP(6)");
		return "TIMESTAMP";
	}
	if (t.type === "DECIMAL") {
		require(
			Number.isInteger(t.precision) && Number.isInteger(t.scale) &&
				t.precision! >= 1 && t.precision! <= 28 &&
				t.scale! >= 0 && t.scale! <= t.precision!,
			"DECIMAL precision 1..28 and scale 0..precision",
		);
		return `DECIMAL(${t.precision},${t.scale})`;
	}
	return t.type;
}

function checkUniqueNames(values: string[], scope: string) {
	require(
		new Set(values.map((v) => v.toLowerCase())).size === values.length,
		`case collision in ${scope}`,
	);
}

export function admitSchema(schema: Schema, view = "result"): Relation {
	require(schema.inputs.length > 0, "base tables required");
	const output = schema.outputs.find((r) => r.name === view);
	require(output !== undefined, "selected output view");
	checkUniqueNames(
		[...schema.inputs, ...schema.outputs].map((r) => r.name),
		"relations",
	);
	for (const relation of [...schema.inputs, ...schema.outputs]) {
		require(relation.fields.length > 0, `empty relation ${relation.name}`);
		checkUniqueNames(
			relation.fields.map((f) => f.name),
			`columns of ${relation.name}`,
		);
		for (const field of relation.fields) type(field.columntype);
	}
	return output;
}

function skipComment(sql: string, i: number): number {
	if (sql[i] === "-" && sql[i + 1] === "-") {
		let end = i + 2;
		while (end < sql.length && sql[end] !== "\n") end++;
		return end;
	}
	if (sql[i] === "/" && sql[i + 1] === "*") {
		const close = sql.indexOf("*/", i + 2);
		require(close >= 0, "unterminated block comment");
		return close + 2;
	}
	return i;
}

function skipQuoted(sql: string, i: number): number {
	const q = sql[i];
	let pos = i + 1;
	while (pos < sql.length) {
		if (sql[pos] === q && sql[pos + 1] === q) {
			pos += 2;
			continue;
		}
		if (sql[pos] === q) return pos + 1;
		pos++;
	}
	throw new Error("OUTSIDE_EXPORT_PROFILE: unterminated quoted token");
}

// Replaces comments and single-quoted string literals with spaces of identical
// length, and double-quoted identifiers with underscores, so keyword searches
// never match inside literals, comments, or quoted identifiers.
function maskCodeOnly(sql: string): string {
	let out = "";
	let i = 0;
	while (i < sql.length) {
		const commentEnd = skipComment(sql, i);
		if (commentEnd > i) {
			out += " ".repeat(commentEnd - i);
			i = commentEnd;
			continue;
		}
		if (sql[i] === "'") {
			const end = skipQuoted(sql, i);
			out += " ".repeat(end - i);
			i = end;
			continue;
		}
		if (sql[i] === '"') {
			const end = skipQuoted(sql, i);
			out += "_".repeat(end - i);
			i = end;
			continue;
		}
		out += sql[i++];
	}
	return out;
}

function splitTopLevel(text: string, delimiter: string): string[] {
	const parts: string[] = [];
	let start = 0;
	let depth = 0;
	let i = 0;
	while (i < text.length) {
		const commentEnd = skipComment(text, i);
		if (commentEnd > i) {
			i = commentEnd;
			continue;
		}
		if (text[i] === "'" || text[i] === '"') {
			i = skipQuoted(text, i);
			continue;
		}
		if (text[i] === "(") depth++;
		else if (text[i] === ")") {
			require(depth > 0, "unbalanced parenthesis");
			depth--;
		} else if (depth === 0 && text[i] === delimiter) {
			const slice = text.slice(start, i).trim();
			if (slice.length > 0) parts.push(slice);
			start = i + 1;
		}
		i++;
	}
	require(depth === 0, "unbalanced parenthesis");
	const tail = text.slice(start).trim();
	if (tail.length > 0) parts.push(tail);
	return parts;
}

function parseIdent(raw: string): { name: string; quoted: boolean } {
	const trimmed = raw.trim();
	if (trimmed.startsWith('"') && trimmed.endsWith('"') && trimmed.length >= 2) {
		return {
			name: trimmed.slice(1, -1).replaceAll('""', '"'),
			quoted: true,
		};
	}
	require(
		/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(trimmed),
		`invalid identifier ${trimmed}`,
	);
	return { name: trimmed.toLowerCase(), quoted: false };
}

export function parseDeclaredType(spec: string): Type {
	const normalized = spec.trim().replace(/\s+/g, " ");
	const nullable = !/\bNOT\s+NULL$/i.test(normalized);
	const base = normalized.replace(/\s*\b(?:NOT\s+NULL|NULL)\s*$/i, "").trim()
		.toUpperCase();
	if (/^VARCHAR(?:\(\d+\))?$/.test(base) || base === "TEXT") {
		return { nullable, precision: -1, type: "VARCHAR" };
	}
	if (base === "INTEGER" || base === "INT" || base === "INT4") {
		return { nullable, type: "INTEGER" };
	}
	if (base === "BIGINT" || base === "INT8") {
		return { nullable, type: "BIGINT" };
	}
	if (base === "BOOLEAN" || base === "BOOL") {
		return { nullable, type: "BOOLEAN" };
	}
	if (base === "DOUBLE" || base === "DOUBLE PRECISION") {
		return { nullable, type: "DOUBLE" };
	}
	if (base === "DATE") {
		return { nullable, type: "DATE" };
	}
	if (base === "UUID") {
		return { nullable, type: "UUID" };
	}
	const ts = /^TIMESTAMP(?:\((\d+)\))?$/.exec(base);
	if (ts) {
		const precision = ts[1] ? Number(ts[1]) : 6;
		require(precision === 6, "TIMESTAMP(6)");
		return { nullable, precision: 6, type: "TIMESTAMP" };
	}
	const dec = /^(?:DECIMAL|NUMERIC)\(\s*(\d+)\s*,\s*(\d+)\s*\)$/.exec(base);
	if (dec) {
		const precision = Number(dec[1]);
		const scale = Number(dec[2]);
		const result: Type = { nullable, precision, scale, type: "DECIMAL" };
		type(result);
		return result;
	}
	throw new Error(`OUTSIDE_EXPORT_PROFILE: declared type ${spec}`);
}

export function parseProgram(sql: string): ParsedProgram {
	const inputs: Relation[] = [];
	const views: ParsedView[] = [];
	for (const rawStmt of splitTopLevel(sql, ";")) {
		const stmt = stripComments(rawStmt);
		if (!stmt) continue;
		const tableMatch =
			/^CREATE\s+TABLE\s+("[^"]+"|[a-zA-Z_][a-zA-Z0-9_]*)\s*\(([\s\S]*)\)$/i
				.exec(stmt);
		if (tableMatch) {
			const id = parseIdent(tableMatch[1]);
			const cols = splitTopLevel(tableMatch[2], ",").map((colDef): Field => {
				const clean = stripComments(colDef);
				const colMatch = /^("[^"]+"|[a-zA-Z_][a-zA-Z0-9_]*)\s+([\s\S]+)$/.exec(
					clean,
				);
				require(colMatch !== null, `invalid column definition ${clean}`);
				const colId = parseIdent(colMatch[1]);
				return {
					name: colId.name,
					case_sensitive: colId.quoted,
					columntype: parseDeclaredType(colMatch[2]),
					unused: false,
				};
			});
			require(cols.length > 0, `empty table ${id.name}`);
			checkUniqueNames(cols.map((c) => c.name), `columns of ${id.name}`);
			inputs.push({
				name: id.name,
				case_sensitive: id.quoted,
				fields: cols,
				materialized: false,
				foreign_keys: [],
			});
			continue;
		}
		const viewMatch =
			/^CREATE\s+(LOCAL\s+|MATERIALIZED\s+)?VIEW\s+("[^"]+"|[a-zA-Z_][a-zA-Z0-9_]*)\s+AS\s+([\s\S]+)$/i
				.exec(stmt);
		require(viewMatch !== null, `unsupported statement: ${stmt.slice(0, 60)}`);
		const kind = (viewMatch[1] ?? "").trim().toUpperCase();
		const id = parseIdent(viewMatch[2]);
		views.push({
			name: id.name,
			body: viewMatch[3].trim(),
			materialized: kind === "MATERIALIZED",
		});
	}
	require(inputs.length > 0, "base tables required");
	checkUniqueNames(
		[...inputs.map((i) => i.name), ...views.map((v) => v.name)],
		"relations",
	);
	return { inputs, views };
}

function scanCall(
	sql: string,
	startAt: number,
): { args: string[]; end: number } {
	let pos = startAt;
	let depth = 1;
	let argStart = pos;
	const args: string[] = [];
	while (pos < sql.length && depth > 0) {
		const commentEnd = skipComment(sql, pos);
		if (commentEnd > pos) {
			pos = commentEnd;
			continue;
		}
		if (sql[pos] === "'" || sql[pos] === '"') {
			pos = skipQuoted(sql, pos);
			continue;
		}
		const ch = sql[pos];
		if (ch === "(") {
			depth++;
		} else if (ch === ")") {
			depth--;
			if (depth === 0) {
				args.push(sql.slice(argStart, pos).trim());
				return { args, end: pos + 1 };
			}
		} else if (ch === "," && depth === 1) {
			args.push(sql.slice(argStart, pos).trim());
			argStart = pos + 1;
		}
		pos++;
	}
	throw new Error("OUTSIDE_EXPORT_PROFILE: unterminated function call");
}

function replacePositionCalls(sql: string): string {
	const token = '"POSITION"(';
	let out = "";
	let i = 0;
	while (i < sql.length) {
		const commentEnd = skipComment(sql, i);
		if (commentEnd > i) {
			out += sql.slice(i, commentEnd);
			i = commentEnd;
			continue;
		}
		if (sql[i] === "'") {
			const end = skipQuoted(sql, i);
			out += sql.slice(i, end);
			i = end;
			continue;
		}
		if (!sql.startsWith(token, i)) {
			if (sql[i] === '"') {
				const end = skipQuoted(sql, i);
				out += sql.slice(i, end);
				i = end;
				continue;
			}
			out += sql[i++];
			continue;
		}
		const { args, end } = scanCall(sql, i + token.length);
		require(args.length === 2, "POSITION arity");
		out += `strpos(${replacePositionCalls(args[1])}, ${
			replacePositionCalls(args[0])
		})`;
		i = end;
	}
	return out;
}

function mapUnquoted(sql: string, fn: (chunk: string) => string): string {
	let out = "";
	let i = 0;
	let plain = 0;
	while (i < sql.length) {
		const commentEnd = skipComment(sql, i);
		if (commentEnd > i) {
			if (i > plain) out += fn(sql.slice(plain, i));
			out += sql.slice(i, commentEnd);
			i = commentEnd;
			plain = i;
			continue;
		}
		if (sql[i] === "'" || sql[i] === '"') {
			if (i > plain) out += fn(sql.slice(plain, i));
			const end = skipQuoted(sql, i);
			out += sql.slice(i, end);
			i = end;
			plain = i;
			continue;
		}
		i++;
	}
	if (plain < sql.length) out += fn(sql.slice(plain));
	return out;
}

function replaceNamedCalls(
	sql: string,
	pattern: RegExp,
	render: (args: string[]) => string,
): string {
	let current = sql;
	for (;;) {
		const masked = maskCodeOnly(current);
		pattern.lastIndex = 0;
		const match = pattern.exec(masked);
		if (!match) return current;
		const { args, end } = scanCall(current, match.index + match[0].length);
		current = current.slice(0, match.index) + render(args) + current.slice(end);
	}
}

function finiteEpochUs(expr: string): string {
	return `(CASE WHEN (${expr}) IS NULL OR isfinite(${expr}) THEN epoch_us(${expr}) ELSE error('finite TIMESTAMP required') END)`;
}

function rewriteAsofJoins(sql: string): string {
	const head =
		/(\bLEFT\s+ASOF\s+JOIN\s+)(_+|[a-zA-Z_][a-zA-Z0-9_]*)(?:(\s+(?:AS\s+)?)(?!MATCH_CONDITION\b)(_+|[a-zA-Z_][a-zA-Z0-9_]*))?\s+MATCH_CONDITION\s*\(/gi;
	const boundary =
		/^\b(?:LEFT|RIGHT|INNER|FULL|CROSS|ASOF|NATURAL|JOIN|WHERE|GROUP|HAVING|ORDER|LIMIT|OFFSET|UNION|INTERSECT|EXCEPT)\b/i;
	let current = sql;
	for (;;) {
		const masked = maskCodeOnly(current);
		head.lastIndex = 0;
		const match = head.exec(masked);
		if (!match) return current;
		const tableStart = match.index + match[1].length;
		const tableName = current.slice(tableStart, tableStart + match[2].length);
		const aliasClause = match[4]
			? " " +
				current.slice(
					tableStart + match[2].length + match[3].length,
					tableStart + match[2].length + match[3].length + match[4].length,
				)
			: "";
		const matchCall = scanCall(current, match.index + match[0].length);
		require(matchCall.args.length === 1, "ASOF MATCH_CONDITION");
		const onHead = /^\s*ON\s+/i.exec(masked.slice(matchCall.end));
		require(onHead !== null, "ASOF ON clause");
		const onStart = matchCall.end + onHead[0].length;
		let pos = onStart;
		let depth = 0;
		let stopAt = current.length;
		while (pos < masked.length) {
			const ch = masked[pos];
			if (ch === "(") depth++;
			else if (ch === ")") {
				if (depth === 0) {
					stopAt = pos;
					break;
				}
				depth--;
			} else if (
				depth === 0 &&
				(pos === 0 || !/[a-zA-Z0-9_]/.test(masked[pos - 1])) &&
				boundary.test(masked.slice(pos))
			) {
				stopAt = pos;
				break;
			}
			pos++;
		}
		const eqCond = current.slice(onStart, stopAt).trim();
		const replacement =
			`ASOF LEFT JOIN ${tableName}${aliasClause} ON (${eqCond}) AND (${
				matchCall.args[0]
			}) `;
		current = current.slice(0, match.index) + replacement +
			current.slice(stopAt);
	}
}

function replaceMaskedPattern(
	sql: string,
	maskedRegex: RegExp,
	render: (rawMatch: string) => string,
): string {
	const flags = maskedRegex.flags.includes("g")
		? maskedRegex.flags
		: maskedRegex.flags + "g";
	const pattern = new RegExp(maskedRegex.source, flags);
	let current = sql;
	let from = 0;
	for (;;) {
		const masked = maskCodeOnly(current);
		pattern.lastIndex = from;
		const match = pattern.exec(masked);
		if (!match) return current;
		const raw = current.slice(match.index, match.index + match[0].length);
		const replacement = render(raw);
		current = current.slice(0, match.index) + replacement +
			current.slice(match.index + match[0].length);
		from = match.index + replacement.length;
	}
}

function stripComments(sql: string): string {
	let out = "";
	let i = 0;
	while (i < sql.length) {
		const commentEnd = skipComment(sql, i);
		if (commentEnd > i) {
			out += sql[i] === "-" && commentEnd < sql.length ? "\n" : " ";
			i = commentEnd;
			continue;
		}
		if (sql[i] === "'" || sql[i] === '"') {
			const end = skipQuoted(sql, i);
			out += sql.slice(i, end);
			i = end;
			continue;
		}
		out += sql[i++];
	}
	return out.trim();
}

function splitTopLevelSubtraction(expr: string): [string, string] {
	const masked = maskCodeOnly(expr);
	let depth = 0;
	let splitAt = -1;
	for (let i = 0; i < masked.length; i++) {
		const ch = masked[i];
		if (ch === "(") depth++;
		else if (ch === ")") depth--;
		else if (depth === 0 && ch === "-") {
			let prev = i - 1;
			while (prev >= 0 && /\s/.test(masked[prev])) prev--;
			if (prev >= 0 && !"(+-*/,=<>".includes(masked[prev])) {
				splitAt = i;
			}
		}
	}
	require(splitAt > 0, `timestamp subtraction ${expr}`);
	return [expr.slice(0, splitAt).trim(), expr.slice(splitAt + 1).trim()];
}

function rewriteTimestampDiffCasts(sql: string): string {
	const head = /\bCAST\s*\(/gi;
	let current = sql;
	let from = 0;
	for (;;) {
		const masked = maskCodeOnly(current);
		head.lastIndex = from;
		const match = head.exec(masked);
		if (!match) return current;
		const call = scanCall(current, match.index + match[0].length);
		if (call.args.length !== 1) {
			from = match.index + match[0].length;
			continue;
		}
		const arg = call.args[0].trim();
		const maskedArg = maskCodeOnly(arg);
		const tail =
			/\)\s*(YEAR|MONTH|DAY|HOUR|MINUTE|SECOND)S?\s+AS\s+([a-zA-Z0-9_]+)\s*$/i
				.exec(maskedArg);
		if (!tail) {
			from = match.index + match[0].length;
			continue;
		}
		const unit = tail[1].toUpperCase();
		const rawTarget = tail[2].toUpperCase();
		require(unit === "SECOND", `interval cast unit ${unit}`);
		const targetType = rawTarget === "INT" || rawTarget === "INT4" ||
				rawTarget === "INTEGER"
			? "INTEGER"
			: rawTarget === "INT8" || rawTarget === "BIGINT"
			? "BIGINT"
			: "";
		require(targetType !== "", `interval cast target ${rawTarget}`);
		const closeParen = tail.index;
		require(arg.startsWith("("), "parenthesized timestamp difference");
		const innerCheck = scanCall(arg, 1);
		require(
			innerCheck.end - 1 === closeParen && innerCheck.args.length === 1,
			"parenthesized timestamp difference",
		);
		const [lhs, rhs] = splitTopLevelSubtraction(arg.slice(1, closeParen));
		const a = duckdbExpression(lhs);
		const b = duckdbExpression(rhs);
		const replacement = `CAST(((${finiteEpochUs(a)}::HUGEINT - ${
			finiteEpochUs(b)
		}::HUGEINT) // 1000000) AS ${targetType})`;
		current = current.slice(0, match.index) + replacement +
			current.slice(call.end);
		from = match.index + replacement.length;
	}
}

function splitTopLevelKeyword(
	expr: string,
	keyword: string,
): [string, string] | null {
	const masked = maskCodeOnly(expr);
	const re = new RegExp(`\\b${keyword}\\b`, "gi");
	let match: RegExpExecArray | null;
	while ((match = re.exec(masked)) !== null) {
		let depth = 0;
		for (let i = 0; i < match.index; i++) {
			if (masked[i] === "(") depth++;
			else if (masked[i] === ")") depth--;
		}
		if (depth === 0) {
			return [
				expr.slice(0, match.index).trim(),
				expr.slice(match.index + match[0].length).trim(),
			];
		}
	}
	return null;
}

function parseSubstringArgs(rawArgs: string[]): {
	value: string;
	start: string;
	length?: string;
} {
	if (rawArgs.length === 1) {
		const fromSplit = splitTopLevelKeyword(rawArgs[0], "FROM");
		require(fromSplit !== null, "SUBSTRING FROM clause");
		const forSplit = splitTopLevelKeyword(fromSplit[1], "FOR");
		return forSplit
			? { value: fromSplit[0], start: forSplit[0], length: forSplit[1] }
			: { value: fromSplit[0], start: fromSplit[1] };
	}
	require(
		rawArgs.length === 2 || rawArgs.length === 3,
		"SUBSTRING arity",
	);
	return {
		value: rawArgs[0],
		start: rawArgs[1],
		...(rawArgs.length === 3 ? { length: rawArgs[2] } : {}),
	};
}

function checkSubstringBoundLiteral(expr: string, min: number): boolean {
	const clean = expr.trim();
	if (!/^[+-]?\d+$/.test(clean)) return false;
	const n = Number(clean);
	require(
		Number.isSafeInteger(n) && n >= min,
		"SUBSTRING positive literal start and nonnegative literal length",
	);
	return true;
}

function rewriteSubstringCalls(sql: string): string {
	const masked = maskCodeOnly(sql);
	const head = /\b(?:SUBSTRING|SUBSTR)\s*\(/gi;
	let out = "";
	let cursor = 0;
	for (;;) {
		head.lastIndex = cursor;
		const match = head.exec(masked);
		if (!match) break;
		const call = scanCall(sql, match.index + match[0].length);
		const parsed = parseSubstringArgs(call.args);
		const startLiteral = checkSubstringBoundLiteral(parsed.start, 1);
		const lenLiteral = parsed.length === undefined
			? true
			: checkSubstringBoundLiteral(parsed.length, 0);
		const valSql = rewriteSubstringCalls(parsed.value);
		const startSql = rewriteSubstringCalls(parsed.start);
		const lenSql = parsed.length !== undefined
			? rewriteSubstringCalls(parsed.length)
			: undefined;
		const callSql = lenSql !== undefined
			? `substring(${valSql}, ${startSql}, ${lenSql})`
			: `substring(${valSql}, ${startSql})`;
		const replacement = startLiteral && lenLiteral
			? callSql
			: `CASE WHEN (${valSql}) IS NULL OR (${startSql}) IS NULL${
				lenSql !== undefined ? ` OR (${lenSql}) IS NULL` : ""
			} THEN NULL WHEN (${startSql}) >= 1${
				lenSql !== undefined ? ` AND (${lenSql}) >= 0` : ""
			} THEN ${callSql} ELSE error('SUBSTRING bounds outside positive-start/nonnegative-length profile') END`;
		out += sql.slice(cursor, match.index) + replacement;
		cursor = call.end;
	}
	out += sql.slice(cursor);
	return out;
}

export function duckdbExpression(sql: string): string {
	let out = stripComments(sql);
	out = replacePositionCalls(out);
	out = rewriteSubstringCalls(out);
	out = rewriteAsofJoins(out);
	out = rewriteTimestampDiffCasts(out);
	out = replaceNamedCalls(out, /\bFLOOR\s*\(/gi, (args) => {
		require(args.length === 1, "FLOOR arity");
		const toMonth = /^([\s\S]+?)\s+TO\s+MONTH$/i.exec(args[0]);
		require(toMonth !== null, "FLOOR unit");
		const inner = duckdbExpression(toMonth[1].trim());
		return `date_trunc('month', make_timestamp(${finiteEpochUs(inner)}))`;
	});
	out = replaceNamedCalls(out, /\bTIMESTAMPDIFF\s*\(/gi, (args) => {
		require(
			args.length === 3 && args[0].toUpperCase() === "SECOND",
			"TIMESTAMPDIFF SECOND",
		);
		const a = duckdbExpression(args[1]);
		const b = duckdbExpression(args[2]);
		return `CAST(((${finiteEpochUs(b)}::HUGEINT - ${
			finiteEpochUs(a)
		}::HUGEINT) // 1000000) AS INTEGER)`;
	});
	out = replaceMaskedPattern(
		out,
		/\bINTERVAL\s+ +\s+(?:DAY|SECOND|MINUTE|HOUR|YEAR)S?\b/gi,
		(raw) => {
			const m = /^INTERVAL\s+'(-?\d+)'\s+(DAY|SECOND|MINUTE|HOUR|YEAR)S?$/i
				.exec(raw);
			require(m !== null, `interval literal ${raw}`);
			return `INTERVAL '${m[1]} ${m[2].toUpperCase()}'`;
		},
	);
	out = mapUnquoted(
		out,
		(chunk) => chunk.replaceAll(/(?<![/*])\/(?![/*])/g, "//"),
	);
	return out;
}

interface SqlToken {
	kind: "word" | "quoted" | "string" | "number" | "symbol";
	raw: string;
	start: number;
	end: number;
}

function tokenizeSql(sql: string): SqlToken[] {
	const tokens: SqlToken[] = [];
	let i = 0;
	while (i < sql.length) {
		if (/\s/.test(sql[i])) {
			i++;
			continue;
		}
		const commentEnd = skipComment(sql, i);
		if (commentEnd > i) {
			i = commentEnd;
			continue;
		}
		if (sql[i] === "'") {
			const end = skipQuoted(sql, i);
			tokens.push({ kind: "string", raw: sql.slice(i, end), start: i, end });
			i = end;
			continue;
		}
		if (sql[i] === '"') {
			const end = skipQuoted(sql, i);
			tokens.push({ kind: "quoted", raw: sql.slice(i, end), start: i, end });
			i = end;
			continue;
		}
		const word = /^[a-zA-Z_][a-zA-Z0-9_]*/.exec(sql.slice(i));
		if (word) {
			const end = i + word[0].length;
			tokens.push({ kind: "word", raw: word[0], start: i, end });
			i = end;
			continue;
		}
		const num = /^[0-9]+(?:\.[0-9]+)?/.exec(sql.slice(i));
		if (num) {
			const end = i + num[0].length;
			tokens.push({ kind: "number", raw: num[0], start: i, end });
			i = end;
			continue;
		}
		tokens.push({ kind: "symbol", raw: sql[i], start: i, end: i + 1 });
		i++;
	}
	return tokens;
}

const CLAUSE_KEYWORDS = new Set([
	"on",
	"using",
	"where",
	"group",
	"having",
	"order",
	"limit",
	"offset",
	"union",
	"intersect",
	"except",
	"inner",
	"left",
	"right",
	"full",
	"cross",
	"asof",
	"natural",
	"join",
	"window",
	"qualify",
]);

const FROM_END_KEYWORDS = new Set([
	"where",
	"group",
	"having",
	"order",
	"limit",
	"offset",
	"union",
	"intersect",
	"except",
	"window",
	"qualify",
]);

interface TableReferenceSpan {
	key: string;
	name: string;
	start: number;
	end: number;
	hasExplicitAlias: boolean;
}

interface ScopeFrame {
	query: boolean;
	inFrom: boolean;
	ctes: Set<string>;
	inWithHeader: boolean;
	recursiveWith: boolean;
	pendingCte: string | null;
	awaitingCteBody: boolean;
	onCloseCte: string | null;
}

function makeScope(
	query: boolean,
	onCloseCte: string | null = null,
): ScopeFrame {
	return {
		query,
		inFrom: false,
		ctes: new Set(),
		inWithHeader: false,
		recursiveWith: false,
		pendingCte: null,
		awaitingCteBody: false,
		onCloseCte,
	};
}

function isShadowedByCte(stack: ScopeFrame[], name: string): boolean {
	const key = name.toLowerCase();
	for (let i = stack.length - 1; i >= 0; i--) {
		if (stack[i].ctes.has(key)) return true;
	}
	return false;
}

function findTableReferenceSpans(
	sql: string,
	candidates: Set<string>,
): TableReferenceSpan[] {
	const tokens = tokenizeSql(sql);
	const spans: TableReferenceSpan[] = [];
	const stack: ScopeFrame[] = [makeScope(true)];
	let expectRelation = false;
	for (let i = 0; i < tokens.length; i++) {
		const tok = tokens[i];
		const scope = stack[stack.length - 1];
		if (tok.kind === "symbol") {
			if (tok.raw === "(") {
				if (scope.query && scope.inWithHeader && scope.awaitingCteBody) {
					const closingCte = scope.pendingCte;
					scope.pendingCte = null;
					scope.awaitingCteBody = false;
					stack.push(makeScope(true, closingCte));
					expectRelation = false;
				} else {
					const nextKw = tokens[i + 1]?.kind === "word"
						? tokens[i + 1].raw.toLowerCase()
						: "";
					const isSubquery = nextKw === "select" || nextKw === "with" ||
						nextKw === "values";
					if (expectRelation && !isSubquery) {
						const joined = makeScope(true);
						joined.inFrom = true;
						stack.push(joined);
					} else {
						stack.push(makeScope(isSubquery));
						expectRelation = false;
					}
				}
			} else if (tok.raw === ")") {
				const closed = stack.length > 1 ? stack.pop()! : undefined;
				const parent = stack[stack.length - 1];
				if (closed?.onCloseCte) {
					parent.ctes.add(closed.onCloseCte);
					if (tokens[i + 1]?.kind !== "symbol" || tokens[i + 1]?.raw !== ",") {
						parent.inWithHeader = false;
					}
				}
				expectRelation = false;
			} else if (tok.raw === ",") {
				if (scope.query && scope.inFrom) expectRelation = true;
			} else if (tok.raw === ";") {
				scope.inFrom = false;
				scope.inWithHeader = false;
				expectRelation = false;
			}
			continue;
		}
		const lower = tok.kind === "word" ? tok.raw.toLowerCase() : "";
		if (scope.query && scope.inWithHeader) {
			if (lower === "recursive" && scope.pendingCte === null) {
				scope.recursiveWith = true;
				continue;
			}
			if (
				scope.pendingCte === null &&
				(tok.kind === "word" || tok.kind === "quoted")
			) {
				scope.pendingCte = parseIdent(tok.raw).name.toLowerCase();
				if (scope.recursiveWith) scope.ctes.add(scope.pendingCte);
				continue;
			}
			if (lower === "as") {
				scope.awaitingCteBody = true;
				continue;
			}
			if (lower === "not" || lower === "materialized") continue;
		}
		if (expectRelation && (tok.kind === "word" || tok.kind === "quoted")) {
			if (lower === "lateral") continue;
			expectRelation = false;
			require(
				!(tokens[i + 1]?.kind === "symbol" && tokens[i + 1].raw === "."),
				`qualified relation reference ${tok.raw}.*`,
			);
			if (tokens[i + 1]?.kind === "symbol" && tokens[i + 1].raw === "(") {
				continue;
			}
			const parsed = parseIdent(tok.raw);
			const key = parsed.name.toLowerCase();
			if (candidates.has(key) && !isShadowedByCte(stack, key)) {
				const next = tokens[i + 1];
				const hasExplicitAlias = next !== undefined && (
					next.kind === "quoted" ||
					(next.kind === "word" &&
						(next.raw.toLowerCase() === "as" ||
							!CLAUSE_KEYWORDS.has(next.raw.toLowerCase())))
				);
				spans.push({
					key,
					name: parsed.name,
					start: tok.start,
					end: tok.end,
					hasExplicitAlias,
				});
			}
			continue;
		}
		if (!scope.query || tok.kind !== "word") continue;
		if (lower === "with") {
			scope.inWithHeader = true;
			scope.recursiveWith = false;
			scope.pendingCte = null;
			scope.awaitingCteBody = false;
		} else if (lower === "from") {
			scope.inFrom = true;
			expectRelation = true;
		} else if (lower === "join") {
			expectRelation = true;
		} else if (FROM_END_KEYWORDS.has(lower)) {
			scope.inFrom = false;
			expectRelation = false;
		}
	}
	return spans;
}

function scanRelationRefs(body: string, candidates: Set<string>): string[] {
	const seen = new Set<string>();
	const out: string[] = [];
	for (const span of findTableReferenceSpans(body, candidates)) {
		if (!seen.has(span.key)) {
			seen.add(span.key);
			out.push(span.key);
		}
	}
	return out;
}

function rewriteStageRefs(sql: string, stageMap: Map<string, string>): string {
	if (stageMap.size === 0) return sql;
	const spans = findTableReferenceSpans(sql, new Set(stageMap.keys()));
	if (spans.length === 0) return sql;
	let out = "";
	let cursor = 0;
	for (const span of spans) {
		const stage = stageMap.get(span.key)!;
		out += sql.slice(cursor, span.start) +
			(span.hasExplicitAlias
				? quote(stage)
				: `${quote(stage)} AS ${quote(span.name)}`);
		cursor = span.end;
	}
	out += sql.slice(cursor);
	return out;
}

function resolveViewDag(program: ParsedProgram, view: string): {
	ancestors: ParsedView[];
	target: ParsedView;
} {
	const byName = new Map<string, { index: number; view: ParsedView }>();
	program.views.forEach((v, index) =>
		byName.set(v.name.toLowerCase(), { index, view: v })
	);
	const targetEntry = byName.get(view.toLowerCase());
	require(targetEntry !== undefined, `missing view ${view}`);
	const candidateNames = new Set(byName.keys());
	const needed = new Set<number>();
	const visiting = new Set<number>();
	const visit = (index: number) => {
		require(
			!visiting.has(index),
			`recursive view ${program.views[index].name}`,
		);
		if (needed.has(index)) return;
		visiting.add(index);
		for (
			const dep of scanRelationRefs(program.views[index].body, candidateNames)
		) {
			const depEntry = byName.get(dep)!;
			require(
				depEntry.index < index,
				`forward or recursive view reference ${dep}`,
			);
			visit(depEntry.index);
			needed.add(depEntry.index);
		}
		visiting.delete(index);
	};
	visit(targetEntry.index);
	const ancestors = [...needed].sort((a, b) => a - b).map((i) =>
		program.views[i]
	);
	return { ancestors, target: targetEntry.view };
}

const FORBIDDEN_NILADIC = new Set([
	"current_timestamp",
	"current_date",
	"current_time",
	"localtime",
	"localtimestamp",
	"current_user",
	"session_user",
	"current_catalog",
	"current_schema",
	"current_database",
	"current_role",
]);

const SYNTAX_BEFORE_PAREN = new Set([
	"select",
	"from",
	"join",
	"on",
	"using",
	"where",
	"group",
	"by",
	"having",
	"order",
	"values",
	"as",
	"and",
	"or",
	"not",
	"in",
	"exists",
	"case",
	"when",
	"then",
	"else",
	"between",
	"match_condition",
	"with",
	"recursive",
	"materialized",
	"union",
	"intersect",
	"except",
	"distinct",
	"all",
	"any",
	"some",
	"varchar",
	"decimal",
	"numeric",
	"timestamp",
]);

const ADMITTED_FUNCTIONS = new Set([
	"count",
	"sum",
	"min",
	"max",
	"avg",
	"coalesce",
	"nullif",
	"cast",
	"substring",
	"substr",
	"position",
	"char_length",
	"character_length",
	"octet_length",
	"length",
	"lower",
	"upper",
	"trim",
	"btrim",
	"ltrim",
	"rtrim",
	"replace",
	"abs",
	"mod",
	"floor",
	"date_trunc",
	"timestampdiff",
]);

function isIdentifierList(args: string[]): boolean {
	return args.length > 0 && args.every((arg) => {
		const clean = stripComments(arg);
		return (clean.startsWith('"') && clean.endsWith('"') &&
			clean.length >= 2) ||
			/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(clean);
	});
}

export function admitViewBody(sql: string): void {
	const tokens = tokenizeSql(sql);
	const withStack: boolean[] = [false];
	for (let i = 0; i < tokens.length; i++) {
		const tok = tokens[i];
		if (tok.kind === "symbol") {
			if (tok.raw === "(") {
				withStack.push(false);
				continue;
			}
			if (tok.raw === ")") {
				if (withStack.length > 1) withStack.pop();
				continue;
			}
			require(tok.raw !== "%", "modulo operator %");
			require(!tok.raw.includes("~"), `regex operator ${tok.raw}`);
			if (tok.raw === "/") {
				const div = tokens[i + 1];
				require(
					div?.kind === "number" && /^[1-9][0-9]*$/.test(div.raw),
					"division requires a positive integer literal divisor",
				);
			}
		}
		const inWithHeader = withStack[withStack.length - 1];
		if (tok.kind === "word") {
			const lower = tok.raw.toLowerCase();
			require(!FORBIDDEN_NILADIC.has(lower), `nondeterministic ${tok.raw}`);
			require(
				lower !== "lateral" && lower !== "qualify" && lower !== "pivot" &&
					lower !== "unpivot" && lower !== "limit" && lower !== "offset" &&
					lower !== "fetch",
				`${tok.raw.toUpperCase()} clause`,
			);
			require(
				lower !== "like" && lower !== "ilike",
				`${tok.raw.toUpperCase()} operator`,
			);
			require(
				!(lower === "distinct" && tokens[i + 1]?.kind === "word" &&
					tokens[i + 1]?.raw.toLowerCase() === "on"),
				"DISTINCT ON clause",
			);
			require(
				lower !== "tablesample" &&
					!(lower === "sample" && tokens[i - 1]?.kind === "word" &&
						tokens[i - 1]?.raw.toLowerCase() === "using"),
				"sampling clause",
			);
			if (lower === "with") withStack[withStack.length - 1] = true;
			else if (lower === "select" || lower === "values") {
				withStack[withStack.length - 1] = false;
			}
			require(
				lower !== "over" && lower !== "window",
				"window clause",
			);
			require(
				!(lower === "filter" && tokens[i + 1]?.kind === "symbol" &&
					tokens[i + 1]?.raw === "("),
				"aggregate FILTER clause",
			);
		}
		if (
			(tok.kind === "word" || tok.kind === "quoted") &&
			tokens[i + 1]?.kind === "symbol" &&
			tokens[i + 1]?.raw === "("
		) {
			const fnName = parseIdent(tok.raw).name.toLowerCase();
			if (tok.kind === "word" && SYNTAX_BEFORE_PAREN.has(fnName)) continue;
			const prev = tokens[i - 1];
			const prev2 = tokens[i - 2];
			const prevNotKeyword = prev?.kind === "quoted" ||
				(prev?.kind === "word" &&
					!CLAUSE_KEYWORDS.has(prev.raw.toLowerCase()) &&
					prev.raw.toLowerCase() !== "lateral");
			const mayBeColumnList =
				(prev?.kind === "word" && prev.raw.toLowerCase() === "as") ||
				(prev?.kind === "symbol" && prev.raw === ")") ||
				(prevNotKeyword &&
					prev2?.kind === "word" &&
					(prev2.raw.toLowerCase() === "from" ||
						prev2.raw.toLowerCase() === "join")) ||
				(inWithHeader &&
					prev?.kind === "word" &&
					(prev.raw.toLowerCase() === "with" ||
						prev.raw.toLowerCase() === "recursive")) ||
				(inWithHeader && prev?.kind === "symbol" && prev.raw === ",");
			if (
				mayBeColumnList &&
				isIdentifierList(scanCall(sql, tokens[i + 1].end).args)
			) {
				continue;
			}
			require(ADMITTED_FUNCTIONS.has(fnName), `function ${tok.raw}`);
			if (fnName === "mod") {
				const call = scanCall(sql, tokens[i + 1].end);
				require(
					call.args.length === 2 &&
						/^[1-9][0-9]*$/.test(stripComments(call.args[1])),
					"MOD requires a positive integer literal divisor",
				);
			}
		}
	}
}

export function validateProgramViews(program: ParsedProgram): void {
	for (const view of program.views) {
		admitViewBody(view.body);
		resolveViewDag(program, view.name);
	}
}

function projectOutput(output: Relation, fromExpr: string): string {
	const cols = output.fields.map((f) =>
		`CAST(result.${quote(f.name)} AS ${type(f.columntype)}) AS ${quote(f.name)}`
	).join(", ");
	return `SELECT ${cols} FROM ${fromExpr} result`;
}

export function translate(
	sourceSql: string,
	schema: Schema,
	view = "result",
): string {
	const output = admitSchema(schema, view);
	const program = parseProgram(sourceSql);
	const { ancestors, target } = resolveViewDag(program, view);
	for (const a of ancestors) admitViewBody(a.body);
	admitViewBody(target.body);
	const ctes = ancestors.map((a) =>
		`${quote(a.name)} AS (${duckdbExpression(a.body)})`
	);
	return `${ctes.length ? `WITH ${ctes.join(",\n")}\n` : ""}${
		projectOutput(output, `(${duckdbExpression(target.body)})`)
	};\n`;
}

export function translatePhysical(
	sourceSql: string,
	schema: Schema,
	view: string,
	prefix: string,
): PhysicalQuery {
	require(
		/^__duckstream_[a-zA-Z0-9_]+$/.test(prefix),
		"physical stage namespace",
	);
	const output = admitSchema(schema, view);
	const program = parseProgram(sourceSql);
	const { ancestors, target } = resolveViewDag(program, view);
	for (const a of ancestors) admitViewBody(a.body);
	admitViewBody(target.body);
	const stageMap = new Map<string, string>();
	const stages: { name: string; sql: string }[] = [];
	for (const ancestor of ancestors) {
		const stageName = `${prefix}_${stages.length}`;
		const body = rewriteStageRefs(duckdbExpression(ancestor.body), stageMap);
		stages.push({ name: stageName, sql: body });
		stageMap.set(ancestor.name.toLowerCase(), stageName);
	}
	const rootStage = `${prefix}_${stages.length}`;
	stages.push({
		name: rootStage,
		sql: rewriteStageRefs(duckdbExpression(target.body), stageMap),
	});
	return {
		stages,
		sql: `${projectOutput(output, quote(rootStage))};\n`,
	};
}
