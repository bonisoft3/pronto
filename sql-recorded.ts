// Time and randomness enter a machine's step only as recorded input: the
// step's time from its machine's clock(), its draw from draw(), both written
// on the step's receipt. Every other read of either is refused here.
//
// What reads them is Postgres's own answer, not a list of spellings: the SQL
// is parsed by Postgres's parser (libpg_query, PL/pgSQL bodies included), and
// each function and cast it reaches is looked up in the catalog of the
// database it runs on. Refused are:
//
// - a built-in function the catalog marks volatile (random(), gen_random_uuid(),
//   clock_timestamp(), nextval(), set_config(), ...);
// - a built-in the catalog marks stable that takes at most one argument and
//   returns a date, a time or an interval: the transaction's clock (now(),
//   transaction_timestamp(), ...), and what reads it or the session's zone
//   (age(timestamp), timestamptz(date), ...);
// - a cast to a type whose input function is not immutable, written as a cast
//   or as a call of the type's name, whatever it casts: 'now'::timestamptz
//   reads the clock, and so does any text that holds 'now';
// - the SQL standard's clock keywords (CURRENT_TIMESTAMP, CURRENT_DATE, ...);
// - a function's dynamic SQL (EXECUTE), whose text is not known until it runs.
//   A DO block runs once, at deployment, and its EXECUTE reaches no step.
//
// A machine's clock() and draw() are where time and randomness are read and
// recorded, and their bodies are exempt. JavaScript bodies (plv8) are the
// rules', whose cage withholds both.
//
// What is checked is therefore a subset, as Jessie is of JavaScript: the
// PL/pgSQL Postgres's parser reads without a catalog. A function it cannot
// read is a finding, never a function let through. Assigning to a field of a
// variable typed by a table is outside it, since the parser does not know the
// table's columns; UPDATE ... RETURNING ... INTO is the spelling inside.

// The 17 build: the 18.0.0 build answers "Not implemented" or malformed JSON
// for ordinary functions, and PL/pgSQL's grammar did not move between them.
import { loadModule, parsePlPgSQLSync as parsePlPgSQL, parseSync as parse } from "npm:@libpg-query/parser@17.6.10";

/** The catalog this check reads: the volatility of each function Postgres or
 * an extension provides, and whether it is the clock; each type's input
 * function's volatility. */
export type Catalog = {
  functions: Record<string, { volatility: "i" | "s" | "v"; clock: boolean }>;
  types: Record<string, "i" | "s" | "v">;
};

/** The query that reads a Catalog, as one JSON value, from the database the
 * SQL runs on. Overloads share a name, and the most volatile of them stands. */
export const CATALOG_SQL = `SELECT json_build_object(
  'functions', (SELECT json_object_agg(proname, json_build_object('volatility', volatility, 'clock', clock))
    FROM (SELECT p.proname, max(p.provolatile) AS volatility,
            bool_or(p.pronargs <= 1 AND p.provolatile = 's' AND p.prorettype IN ('timestamptz'::regtype,
              'timestamp'::regtype, 'date'::regtype, 'time'::regtype, 'timetz'::regtype, 'interval'::regtype)) AS clock
          FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
          WHERE n.nspname = 'pg_catalog' OR EXISTS (SELECT FROM pg_depend d
            WHERE d.classid = 'pg_proc'::regclass AND d.objid = p.oid AND d.deptype = 'e')
          GROUP BY p.proname) f),
  'types', (SELECT json_object_agg(t.typname, p.provolatile) FROM pg_type t JOIN pg_proc p ON p.oid = t.typinput
    JOIN pg_namespace n ON n.oid = t.typnamespace WHERE n.nspname = 'pg_catalog'));`;

const CLOCK_KEYWORDS = new Set([
  "SVFOP_CURRENT_DATE", "SVFOP_CURRENT_TIME", "SVFOP_CURRENT_TIME_N", "SVFOP_CURRENT_TIMESTAMP",
  "SVFOP_CURRENT_TIMESTAMP_N", "SVFOP_LOCALTIME", "SVFOP_LOCALTIME_N", "SVFOP_LOCALTIMESTAMP", "SVFOP_LOCALTIMESTAMP_N",
]);

type Node = unknown;
const strings = (names: Node[]): string[] => names.map((n) => (n as { String: { sval: string } }).String.sval);

/** Every unrecorded read of time or randomness in `sql`, each named by the
 * function it is in. */
export async function unrecorded(sql: string, catalog: Catalog): Promise<string[]> {
  await loadModule();
  const found = new Set<string>();
  // A machine's own functions are its schema's; any other is Postgres's or an
  // extension's, wherever it was installed.
  const builtin = (names: string[]) => names.length === 1 || !/^hybrid_[a-z0-9_]+$/.test(names[0]);
  // A SQL tree: the calls and casts it holds.
  const walk = (node: Node, where: string) => {
    if (Array.isArray(node)) return node.forEach((n) => walk(n, where));
    if (node === null || typeof node !== "object") return;
    const n = node as Record<string, Record<string, unknown>>;
    if (n.FuncCall) {
      const names = strings(n.FuncCall.funcname as Node[]);
      const fn = catalog.functions[names.at(-1)!];
      // A call by a type's name is its cast.
      const input = names.length === 1 ? catalog.types[names[0]] : undefined;
      if (input !== undefined && input !== "i") found.add(`${where}: casts to ${names[0]}, whose input reads the session`);
      else if (builtin(names) && fn) {
        if (fn.volatility === "v") found.add(`${where}: calls ${names.join(".")}(), which the catalog marks volatile`);
        else if (fn.clock) found.add(`${where}: calls ${names.join(".")}(), the transaction's clock`);
      }
    }
    if (n.TypeCast) {
      const type = strings((n.TypeCast.typeName as { names: Node[] }).names).at(-1)!;
      const input = catalog.types[type];
      if (input !== undefined && input !== "i") found.add(`${where}: casts to ${type}, whose input reads the session`);
    }
    if (n.SQLValueFunction && CLOCK_KEYWORDS.has(n.SQLValueFunction.op as string)) {
      found.add(`${where}: reads ${String(n.SQLValueFunction.op).replace("SVFOP_", "")}, the transaction's clock`);
    }
    for (const value of Object.values(n)) walk(value, where);
  };
  // A statement's text: the expressions PL/pgSQL holds are SQL of their own.
  const query = (text: string, mode: number, where: string) => {
    const assigned = mode >= 3 ? text.slice(text.indexOf(":=") + 2) : text;
    walk(parse(mode === 0 ? assigned : `SELECT ${assigned}`), where);
  };
  const plpgsql = (statement: string, where: string, dynamic: boolean) => {
    const each = (node: Node) => {
      if (Array.isArray(node)) return node.forEach(each);
      if (node === null || typeof node !== "object") return;
      const n = node as Record<string, Record<string, unknown>>;
      if (!dynamic && (n.PLpgSQL_stmt_dynexecute || n.PLpgSQL_stmt_dynfors)) found.add(`${where}: runs dynamic SQL, which no check can read`);
      if (n.PLpgSQL_expr) query(n.PLpgSQL_expr.query as string, (n.PLpgSQL_expr.parseMode as number) ?? 0, where);
      for (const value of Object.values(n)) each(value);
    };
    let tree: Node;
    try {
      tree = parsePlPgSQL(statement);
    } catch (err) {
      // The library reads PL/pgSQL's own refusal as JSON and fails on it.
      found.add(`${where}: is PL/pgSQL Postgres's parser cannot read without a catalog (${(err as Error).message.slice(0, 80)})`);
      return;
    }
    each(tree);
  };
  const tree = parse(sql) as unknown as { stmts: { stmt: Record<string, Record<string, unknown>>; stmt_location?: number; stmt_len?: number }[] };
  // The parser places a statement in bytes, not characters.
  const bytes = new TextEncoder().encode(sql);
  for (const { stmt, stmt_location = 0, stmt_len } of tree.stmts) {
    const text = new TextDecoder().decode(bytes.subarray(stmt_location, stmt_len === undefined ? undefined : stmt_location + stmt_len));
    if (stmt.CreateFunctionStmt) {
      const names = strings(stmt.CreateFunctionStmt.funcname as Node[]);
      const where = names.join(".");
      const option = (name: string) => (stmt.CreateFunctionStmt.options as { DefElem: { defname: string; arg: unknown } }[])
        .find((o) => o.DefElem.defname === name)?.DefElem.arg;
      const language = (option("language") as { String: { sval: string } } | undefined)?.String.sval;
      if (/^hybrid_[a-z0-9_]+$/.test(names[0]) && ["clock", "draw"].includes(names[1])) continue;
      if (language === "plpgsql") plpgsql(text, where, false);
      else if (language === "sql") {
        const body = option("as") as { List: { items: { String: { sval: string } }[] } };
        for (const item of body.List.items) walk(parse(item.String.sval), where);
      } else if (language !== "plv8") walk(stmt, where);
      continue;
    }
    if (stmt.DoStmt) {
      const body = ((stmt.DoStmt.args as { DefElem: { defname: string; arg: { String: { sval: string } } } }[])
        .find((a) => a.DefElem.defname === "as"))!.DefElem.arg.String.sval;
      let tag = "$do$";
      while (body.includes(tag)) tag = tag.slice(0, -1) + "_$";
      plpgsql(`CREATE FUNCTION pg_temp.block() RETURNS void LANGUAGE plpgsql AS ${tag}${body}${tag}`, "a DO block", true);
      continue;
    }
    walk(stmt, Object.keys(stmt)[0]);
  }
  return [...found].sort();
}
