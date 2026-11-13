// The database's schemas, as pronto's SQL meets them (mecha's cluster meta.schema, emit.cue
// `schemas`). pronto's SQL spells the app's schema `public`, as the floor's rls.sql does, and the
// floor's lists `mecha`. Where an app keeps its own, write.ts renames each spelling in a schema
// position, once and by what it names: a floor function to the floor's schema, a list to mecha's,
// anything else in `public` to the app's. A string literal or a quoted identifier that is not a
// schema position keeps its text.
//
// A literal is a schema position when it is a whole qualified name cast to a reg* type, handed to a
// function that resolves one (the catalog's to_reg*, the floor's, or the app's `resolvers`), or a
// row of the floor's lists; or when it is SQL text (it holds whitespace or a parenthesis) in which a
// qualifier opens a word. Dollar-quoted text is code, as function bodies are. So a data literal that
// reads as SQL text naming `public.x` is renamed too: authored SQL keeps no such value.

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
  if (isDefault(s)) return sql;
  const floor = new Set(s.names.floor);
  const lists = new Set(s.names.mecha);
  // An unquoted name is folded to lower case, as PostgreSQL folds it.
  const qualify = (name: string) => (floor.has(name.toLowerCase()) ? s.floor : s.app);
  // Where a string literal is an object's name: cast to one (::regclass, ::regproc...), handed to a
  // function that resolves one (the catalog's, or one the floor makes), or a row of a list the floor
  // makes, which holds qualified names.
  const RESOLVERS = new RegExp(`\\b(to_regclass|to_regproc|to_regprocedure|to_regtype|${[...s.names.floor, ...s.names.mecha, ...s.names.resolvers].join("|")})\\s*\\(\\s*$`, "i");
  const LIST_ROW = new RegExp(`\\binsert\\s+into\\s+(?:mecha|${s.mecha})\\.(?:${s.names.mecha.join("|")})\\b[^;]*$`, "i");
  const nameAt = (end: number) => /^\s*::\s*reg[a-z]+\b/i.test(sql.slice(end)) || RESOLVERS.test(out) || LIST_ROW.test(out);
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
    // a list's row names it), or `public` compared with a catalog's schema column.
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
      // SQL text in a literal (a policy's predicate, a dynamic statement's piece): a qualifier that
      // opens a word is renamed as in code; one inside another word (a host, a path) is not.
      else if (!qualified && /[\s(]/.test(body)) {
        out += "'" + body.replace(/(^|[\s(,=])public\.([a-z_][a-z0-9_]*)/gi, (_m, pre, name) => `${pre}${qualify(name)}.${name}`) + "'";
      } else if (body === "public" && comparedSchema) out += `'${s.app}'`;
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
      if (body === "public" && sql[j + 1] === ".") {
        const quoted = /^"([^"]+)"/.exec(sql.slice(j + 2));
        const name = quoted ? quoted[1] : identAt(j + 2) ?? "";
        out += `"${qualify(name)}"`;
      } else out += sql.slice(i, j + 1);
      i = j + 1;
      continue;
    }
    if (/[A-Za-z_]/.test(c) && !isIdentChar(sql[i - 1]) && sql[i - 1] !== "." && sql[i - 1] !== '"') {
      const word = identAt(i)!;
      const after = i + word.length;
      const lower = word.toLowerCase();
      // A qualifier: public.<name>, mecha.<list>.
      if (lower === "public" && sql[after] === ".") {
        const name = identAt(after + 1);
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
    out += c;
    i++;
  }
  return out;
}
