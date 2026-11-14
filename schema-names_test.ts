import { assertEquals, assertThrows } from "jsr:@std/assert@1.0.11";
import { inSchemas, type Schemas } from "./schema-names.ts";

const DEFAULT: Schemas = { app: "public", floor: "public", mecha: "mecha", names: { floor: [], mecha: [], resolvers: [] } };

const names = { floor: ["app_pre_request", "auth_uid", "current_scopes", "has_scope", "rls_protect"], mecha: ["rls_exempt", "shape_key", "shape_reach", "traceparent"], resolvers: ["widen"] };
const own: Schemas = { app: "orders", floor: "mecha", mecha: "mecha", names };
// The floor left in public while the app moves: no rename of the app's may reach the floor's.
const floorInPublic: Schemas = { app: "orders", floor: "public", mecha: "mecha", names };
const listsApart: Schemas = { app: "app", floor: "fl", mecha: "lists", names };

// [why, schemas, sql in, sql out]
const cases: [string, Schemas, string, string][] = [
  ["the defaults leave the text as it is", DEFAULT, "SELECT public.x FROM \"public\".y WHERE 'https://public.example/a' <> ''", "SELECT public.x FROM \"public\".y WHERE 'https://public.example/a' <> ''"],
  ["an unqualified qualifier is the app's", own, "SELECT * FROM public.supply", "SELECT * FROM orders.supply"],
  ["a floor function is the floor's", own, "SELECT public.app_pre_request(); CALL public.rls_protect('t')", "SELECT mecha.app_pre_request(); CALL mecha.rls_protect('t')"],
  ["the floor in public stays there while the app moves", floorInPublic, "SELECT public.app_pre_request(), public.t", "SELECT public.app_pre_request(), orders.t"],
  ["a quoted schema qualifier is renamed", own, 'UPDATE "public"."schedule" SET x = 1', 'UPDATE "orders"."schedule" SET x = 1'],
  ["a quoted identifier holding a dot is a name, not a schema", own, 'SELECT "public.value" FROM t', 'SELECT "public.value" FROM t'],
  ["a literal that is no name keeps its text", own, "SELECT 'https://public.example/x', 'see://public.b'", "SELECT 'https://public.example/x', 'see://public.b'"],
  ["SQL text in a literal is renamed where a qualifier opens a word", own, "CALL widen('public.t', 'public.core_is_staff() OR public.f(x)'); EXECUTE ' AND EXISTS (SELECT FROM public.r q)'", "CALL widen('orders.t', 'orders.core_is_staff() OR orders.f(x)'); EXECUTE ' AND EXISTS (SELECT FROM orders.r q)'"],
  ["a first literal is a name only for a function that resolves one", own, "SELECT lower('public.foo'), widen('public.foo')", "SELECT lower('public.foo'), widen('orders.foo')"],
  ["a literal naming a table is renamed", own, "INSERT INTO mecha.shape_key VALUES ('public.t', 'id', 'public.p', 'id')", "INSERT INTO mecha.shape_key VALUES ('orders.t', 'id', 'orders.p', 'id')"],
  ["a literal naming a floor function is the floor's", own, "SELECT 'public.auth_uid'::regproc", "SELECT 'mecha.auth_uid'::regproc"],
  ["a setting's name is no object's", own, "SELECT set_config('public.foo', 'x', true), current_setting('public.foo', true)", "SELECT set_config('public.foo', 'x', true), current_setting('public.foo', true)"],
  ["a floor function in upper case is the floor's", own, "SELECT PUBLIC.APP_PRE_REQUEST()", "SELECT mecha.APP_PRE_REQUEST()"],
  ["SET search_path TO is a statement's too", own, "SET search_path TO public, pg_catalog;\nCREATE TABLE t ()", "SET search_path TO orders, mecha, pg_catalog;\nCREATE TABLE t ()"],
  ["a literal that only looks like a name is data", own, "INSERT INTO note (body) VALUES ('public.foo')", "INSERT INTO note (body) VALUES ('public.foo')"],
  ["a literal cast to a name type is a name, the type bare or pg_catalog's", own, "SELECT 'public.t'::regclass, 'public.t'::pg_catalog.regclass, 'public.f'::pg_catalog.regproc, 'public.ty'::\"pg_catalog\".regtype, 'public.t'::text", "SELECT 'orders.t'::regclass, 'orders.t'::pg_catalog.regclass, 'orders.f'::pg_catalog.regproc, 'orders.ty'::\"pg_catalog\".regtype, 'public.t'::text"],
  ["a cast to every object-reference type is a name", own, "SELECT 'public.a'::regcollation, 'public.b'::regconfig, 'public.c'::regdictionary, 'public.d'::regoper, 'public.e'::regoperator, 'public.f'::regprocedure, 'public.g'::REGCLASS, 'public.h'::\"regclass\"", "SELECT 'orders.a'::regcollation, 'orders.b'::regconfig, 'orders.c'::regdictionary, 'orders.d'::regoper, 'orders.e'::regoperator, 'orders.f'::regprocedure, 'orders.g'::REGCLASS, 'orders.h'::\"regclass\""],
  ["a cast to another type is data, whatever its name begins with or however it is quoted", own, "SELECT 'public.t'::region, 'public.t'::pg_catalog.region, 'public.t'::regclassy, 'public.t'::\"Regclass\", 'public.t'::\"region\"", "SELECT 'public.t'::region, 'public.t'::pg_catalog.region, 'public.t'::regclassy, 'public.t'::\"Regclass\", 'public.t'::\"region\""],
  ["a literal a resolver reads is a name", own, "SELECT to_regclass('public.t'); CALL rls_protect('public.t')", "SELECT to_regclass('orders.t'); CALL rls_protect('orders.t')"],
  ["an unquoted qualifier in any case", own, "SELECT * FROM PUBLIC.supply; GRANT USAGE ON SCHEMA Public TO anon", "SELECT * FROM orders.supply; GRANT USAGE ON SCHEMA orders TO anon"],
  ["a quoted PUBLIC is another name", own, 'SELECT * FROM "PUBLIC".t', 'SELECT * FROM "PUBLIC".t'],
  ["mecha's schema compared by name moves with it", listsApart, "WHERE schemaname = 'mecha' AND tablename = 'txn_trace'", "WHERE schemaname = 'lists' AND tablename = 'txn_trace'"],
  ["a catalog's schema compared with public", own, "WHERE pubname = 'p' AND schemaname = 'public' AND x = 'public'", "WHERE pubname = 'p' AND schemaname = 'orders' AND x = 'public'"],
  ["a grant on the schema", own, "GRANT USAGE ON SCHEMA public TO anon;\nALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO electric;", "GRANT USAGE ON SCHEMA orders TO anon;\nALTER DEFAULT PRIVILEGES IN SCHEMA orders GRANT SELECT ON TABLES TO electric;"],
  ["a function's pin: the catalog first, temp last", own, "LANGUAGE sql SET search_path = public, pg_catalog AS $$ SELECT 1 $$", "LANGUAGE sql SET search_path = pg_catalog, orders, mecha, pg_temp AS $$ SELECT 1 $$"],
  ["a statement's search_path is the migration's, where names are made", own, "SET search_path = public, pg_catalog;\nCREATE TABLE t ()", "SET search_path = orders, mecha, pg_catalog;\nCREATE TABLE t ()"],
  ["a pin of public alone", own, "SECURITY DEFINER SET search_path = public AS $$", "SECURITY DEFINER SET search_path = pg_catalog, orders, mecha, pg_temp AS $$"],
  ["a function body is code", own, "AS $$ BEGIN PERFORM public.t_fn(); END $$", "AS $$ BEGIN PERFORM orders.t_fn(); END $$"],
  ["comments keep their text", own, "-- public.t\n/* public.u */ SELECT 1", "-- public.t\n/* public.u */ SELECT 1"],
  ["the lists move with mecha's schema, the setting does not", listsApart, "INSERT INTO mecha.rls_exempt VALUES (1); SET LOCAL mecha.traceparent = 'x'; SELECT mecha.traceparent()", "INSERT INTO lists.rls_exempt VALUES (1); SET LOCAL mecha.traceparent = 'x'; SELECT lists.traceparent()"],
  ["a mecha name the floor does not make stays", listsApart, "SELECT mecha.other()", "SELECT mecha.other()"],
  ["no cascade: a renamed schema is not renamed again", listsApart, "SELECT public.auth_uid(), public.t", "SELECT fl.auth_uid(), app.t"],
  ["a word ending in public is no qualifier", own, "SELECT republic.x, x.public", "SELECT republic.x, x.public"],
  ["a literal that reads as SQL text but is data keeps its text", own, "INSERT INTO notes VALUES ('see public.foo here'); UPDATE t SET note = 'a (public.b)'; SELECT lower('x public.y')", "INSERT INTO notes VALUES ('see public.foo here'); UPDATE t SET note = 'a (public.b)'; SELECT lower('x public.y')"],
  ["a dynamic statement's pieces are SQL text, quotes and placeholders too", own, "EXECUTE format('SELECT public.%I()', g); EXECUTE 'SELECT to_regclass(''public.t''), ''public.t''' || x", "EXECUTE format('SELECT orders.%I()', g); EXECUTE 'SELECT to_regclass(''orders.t''), ''public.t''' || x"],
  ["a trigger's arguments are data", own, "FOR EACH ROW EXECUTE FUNCTION f('see public.x'); GRANT EXECUTE ON FUNCTION public.f() TO anon", "FOR EACH ROW EXECUTE FUNCTION f('see public.x'); GRANT EXECUTE ON FUNCTION orders.f() TO anon"],
  ["public declared as an alias names a column in its statement only", own, "SELECT public.id FROM customers AS public; SELECT public.id FROM public.customers public; SELECT public.id FROM public.t", "SELECT public.id FROM customers AS public; SELECT public.id FROM orders.customers public; SELECT orders.id FROM orders.t"],
  ["a quoted name or a spaced dot after public is still qualified", own, 'SELECT public."F", public . foo, "public" . "G", public . auth_uid(), public."auth_uid"()', 'SELECT orders."F", orders . foo, "orders" . "G", mecha . auth_uid(), mecha."auth_uid"()'],
  ["a quoted name that differs in case is not the floor's", own, 'SELECT public."AUTH_UID"()', 'SELECT orders."AUTH_UID"()'],
];

for (const [why, s, sql, want] of cases) {
  Deno.test(why, () => assertEquals(inSchemas(sql, s), want));
}

// What the lexer cannot read safely is refused on schemas of its own, and passes untouched on the defaults.
Deno.test("an escape string or a search_path naming $user is refused on schemas of its own", () => {
  for (const sql of ["INSERT INTO t VALUES (E'it\\'s public.x')", "SELECT e'a'", 'SET search_path = "$user", public;', 'ALTER ROLE r SET search_path TO "$user",public']) {
    assertThrows(() => inSchemas(sql, own), Error, "cannot take", sql);
    assertEquals(inSchemas(sql, DEFAULT), sql);
  }
  // A word ending in e before a literal is no escape string, and $user in a literal is data.
  assertEquals(inSchemas("SELECT 'a' FROM t WHERE note = 'x' AND kind LIKE 'e'", own), "SELECT 'a' FROM t WHERE note = 'x' AND kind LIKE 'e'");
  assertEquals(inSchemas("SELECT set_config('x', '\"$user\"', true)", own), "SELECT set_config('x', '\"$user\"', true)");
});
