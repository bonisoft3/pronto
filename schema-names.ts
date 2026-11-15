// The database's schemas, as pronto's SQL meets them (mecha's cluster meta.schema, emit.cue
// `schemas`). pronto's SQL spells the app's schema `public`, as the floor's rls.sql does, and the
// floor's lists `mecha`. Where an app keeps its own, write.ts renames each spelling in a schema
// position, once and by what it names: a floor function to the floor's schema, a list to mecha's,
// anything else in `public` to the app's. A string literal or a quoted identifier that is not a
// schema position keeps its text.
//
// A literal is a schema position when it is a whole qualified name cast to a reg* type, handed as
// the first argument to a function that resolves one (the catalog's to_reg*, the floor's, or the
// app's `resolvers`), or a row of the floor's lists. A literal is SQL text, renamed as code is, only
// where SQL reads it as such: an argument of a resolver, or a piece of a dynamic statement
// (EXECUTE). Any other literal is data and keeps its text, as does a `public` the statement declares
// as an alias. Dollar-quoted text is code, as function bodies are.

export type Schemas = {
  app: string;
  floor: string;
  mecha: string;
  // The names the floor spells in `public` and in `mecha` (mecha's #Tenancy), and the app's own
  // functions whose first argument names an object (code.meta.schemas.resolvers).
  names: { floor: string[]; mecha: string[]; resolvers: string[] };
};

export const isDefault = (s: Schemas) => s.app === "public" && s.floor === "public" && s.mecha === "mecha";

/** A migration's search_path: the app's schema, where an unqualified name lands, then the floor's. */
export const migrationPath = (s: Schemas) => [...new Set([s.app, s.floor])].join(", ");

/** A function's pinned search_path: the catalog first, the session's temporary schema last. */
export const functionPath = (s: Schemas) => ["pg_catalog", ...new Set([s.app, s.floor]), "pg_temp"].join(", ");

const IDENT = /[A-Za-z_][A-Za-z0-9_$]*/y;
const isIdentChar = (c: string | undefined) => c !== undefined && /[A-Za-z0-9_$]/.test(c);

/** `sql` with its schema spellings renamed for `s`; the text itself where `s` is the default. */
export function inSchemas(sql: string, s: Schemas): string {
  return isDefault(s) ? sql : rename(sql, s);
}

// A qualifier's name: an identifier, a quoted one, or a format() placeholder (`public.%I`).
const NAME = /\s*\.\s*("(?:[^"]|"")+"|[A-Za-z_][A-Za-z0-9_$]*|%[IsL])/y;
// A statement that names `public` as an alias (`FROM t AS public`, `JOIN t public`).
const ALIAS = /\b(?:AS\s+public|(?:FROM|JOIN)\s+(?:"(?:[^"]|"")+"|[A-Za-z_][A-Za-z0-9_$]*)(?:\s*\.\s*(?:"(?:[^"]|"")+"|[A-Za-z_][A-Za-z0-9_$]*))?\s+public)\b(?!\s*\.)/gi;

// A cast to one of PostgreSQL's object-reference types, bare or pg_catalog's: a literal so cast is an
// object's name. The type is read as an identifier, so another type (`region`) is not one, and a
// quoted name is the type only as the type is spelled ("regclass", not "Regclass").
const REG_TYPES = new Set(["regclass", "regcollation", "regconfig", "regdictionary", "regnamespace", "regoper", "regoperator", "regproc", "regprocedure", "regrole", "regtype"]);
const CAST_TYPE = /^\s*::\s*(?:(?:pg_catalog|"pg_catalog")\s*\.\s*)?("[^"]*"|[A-Za-z_][A-Za-z0-9_$]*)/i;
const isRegCast = (rest: string) => {
  const t = CAST_TYPE.exec(rest)?.[1];
  return t !== undefined && REG_TYPES.has(t.startsWith('"') ? t.slice(1, -1) : t.toLowerCase());
};

function rename(sql: string, s: Schemas): string {
  const floor = new Set(s.names.floor);
  const lists = new Set(s.names.mecha);
  // An unquoted name is folded to lower case, as PostgreSQL folds it; a quoted one is as written.
  const qualify = (name: string) => {
    const quoted = name.startsWith('"');
    return floor.has(quoted ? name.slice(1, -1).replaceAll('""', '"') : name.toLowerCase()) ? s.floor : s.app;
  };
  const resolvers = new Set(["to_regclass", "to_regproc", "to_regprocedure", "to_regtype", ...s.names.floor, ...s.names.mecha, ...s.names.resolvers]);
  // Where a string literal is an object's name: cast to one (::regclass, ::pg_catalog.regproc...), handed first to
  // a function that resolves one, or a row of a list the floor makes, which holds qualified names.
  const RESOLVER_FIRST = new RegExp(`\\b(${[...resolvers].join("|")})\\s*\\(\\s*$`, "i");
  const LIST_ROW = new RegExp(`\\binsert\\s+into\\s+(?:mecha|${s.mecha})\\.(?:${s.names.mecha.join("|")})\\b[^;]*$`, "i");
  const nameAt = (end: number) => isRegCast(sql.slice(end)) || RESOLVER_FIRST.test(out) || LIST_ROW.test(out);
  // Where a literal is SQL text: an argument of a resolver, or a piece of a dynamic statement.
  const calls: string[] = [];
  const sqlText = () => resolvers.has(calls.at(-1) ?? "") || /\bEXECUTE\b(?!\s+(?:FUNCTION|PROCEDURE|ON)\b)[^;]*$/i.test(out);
  // The statements in which `public` is an alias, so `public.x` there is a column, not a schema.
  const aliased: [number, number][] = [...sql.matchAll(ALIAS)].map((m) => {
    const end = sql.indexOf(";", m.index);
    return [sql.lastIndexOf(";", m.index) + 1, end === -1 ? sql.length : end];
  });
  // A table named in FROM or JOIN is still schema-qualified there.
  const isAlias = (at: number) => aliased.some(([a, b]) => at >= a && at < b) && !/\b(?:FROM|JOIN)\s*$/i.test(out);
  const nameAfter = (at: number): string | null => {
    NAME.lastIndex = at;
    const m = NAME.exec(sql);
    return m ? m[1] : null;
  };
  let out = "";
  let i = 0;
  const n = sql.length;
  const identAt = (at: number): string | null => {
    IDENT.lastIndex = at;
    const m = IDENT.exec(sql);
    return m ? m[0] : null;
  };
  while (i < n) {
    const c = sql[i];
    // Comments keep their text.
    if (c === "-" && sql[i + 1] === "-") {
      const end = sql.indexOf("\n", i);
      const stop = end === -1 ? n : end;
      out += sql.slice(i, stop);
      i = stop;
      continue;
    }
    if (c === "/" && sql[i + 1] === "*") {
      const end = sql.indexOf("*/", i + 2);
      const stop = end === -1 ? n : end + 2;
      out += sql.slice(i, stop);
      i = stop;
      continue;
    }
    // A string literal: a schema-qualified name as the whole of it ('public.t', as a regclass or
    // a list's row names it), SQL text where SQL reads it, or `public` compared with a catalog's
    // schema column. Anything else is data.
    if (c === "'") {
      let j = i + 1;
      while (j < n) {
        if (sql[j] === "'" && sql[j + 1] === "'") j += 2;
        else if (sql[j] === "'") break;
        else j++;
      }
      const body = sql.slice(i + 1, j);
      const qualified = /^public\.([a-z_][a-z0-9_]*)$/i.exec(body);
      const comparedSchema = /\b(schemaname|table_schema|nspname)\s*=\s*$/i.test(out);
      if (qualified && nameAt(j + 1)) out += `'${qualify(qualified[1])}.${qualified[1]}'`;
      else if (!qualified && sqlText()) out += "'" + rename(body.replaceAll("''", "'"), s).replaceAll("'", "''") + "'";
      else if (body === "public" && comparedSchema) out += `'${s.app}'`;
      else if (body === "mecha" && comparedSchema) out += `'${s.mecha}'`;
      else out += sql.slice(i, j + 1);
      i = j + 1;
      continue;
    }
    // A quoted identifier: `"public"` as a qualifier is the schema; any other keeps its text.
    if (c === '"') {
      let j = i + 1;
      while (j < n) {
        if (sql[j] === '"' && sql[j + 1] === '"') j += 2;
        else if (sql[j] === '"') break;
        else j++;
      }
      const body = sql.slice(i + 1, j);
      const name = body === "public" && !isAlias(i) ? nameAfter(j + 1) : null;
      out += name ? `"${qualify(name)}"` : sql.slice(i, j + 1);
      i = j + 1;
      continue;
    }
    if (/[A-Za-z_]/.test(c) && !isIdentChar(sql[i - 1]) && sql[i - 1] !== "." && sql[i - 1] !== '"') {
      const word = identAt(i)!;
      const after = i + word.length;
      const lower = word.toLowerCase();
      // What this lexer cannot read safely is refused, never passed on half-renamed: an escape string
      // (E'…', whose \' is no end), and a search_path naming "$user", whose schema it cannot place.
      if (lower === "e" && sql[after] === "'") {
        throw new Error(`an app on schemas of its own (${s.app}) cannot take an escape string (E'...'): write it as a standard string`);
      }
      if (lower === "search_path" && /^\s*(?:=|\bTO\b)[^;]*"\$user"/i.test(sql.slice(after))) {
        throw new Error(`an app on schemas of its own (${s.app}) cannot take a search_path naming "$user": name the schemas`);
      }
      // A qualifier: public.<name> (spaced, quoted or a placeholder too), mecha.<list>.
      if (lower === "public" && !isAlias(i)) {
        const name = nameAfter(after);
        if (name) {
          out += qualify(name);
          i = after;
          continue;
        }
      }
      if (lower === "mecha" && sql[after] === "." && s.mecha !== "mecha") {
        const name = identAt(after + 1);
        // A setting named for mecha (SET LOCAL mecha.traceparent) is no schema.
        if (name && lists.has(name.toLowerCase()) && !/\b(SET|RESET)(\s+(LOCAL|SESSION))?\s+$/i.test(out)) {
          out += s.mecha;
          i = after;
          continue;
        }
      }
      // SCHEMA public (a grant, a default privilege).
      if (lower === "schema") {
        const ws = /^\s+/.exec(sql.slice(after));
        if (ws && identAt(after + ws[0].length)?.toLowerCase() === "public" && !isIdentChar(sql[after + ws[0].length + 6])) {
          out += word + ws[0] + s.app;
          i = after + ws[0].length + 6;
          continue;
        }
      }
      // search_path = <list of public and pg_catalog>: in a statement's (SET ...;) public is the
      // migration's path, in its place; a function's pin is the function's.
      if (lower === "search_path") {
        const m = /^(\s*(?:=|\bTO\b)\s*)((?:public|pg_catalog)(?:\s*,\s*(?:public|pg_catalog))*)\b(\s*;)?/i.exec(sql.slice(after));
        if (m && /\bpublic\b/i.test(m[2])) {
          out += word + m[1] + (m[3] ? m[2].replace(/\bpublic\b/i, migrationPath(s)) + m[3] : functionPath(s));
          i = after + m[0].length;
          continue;
        }
      }
      out += word;
      i = after;
      continue;
    }
    if (c === "(") calls.push(/([A-Za-z_][A-Za-z0-9_$]*)\s*$/.exec(out)?.[1].toLowerCase() ?? "");
    if (c === ")") calls.pop();
    out += c;
    i++;
  }
  return out;
}
