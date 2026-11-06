// A function the database calls inside a transaction (docs/decisions/
// 2026-11-05-database-jessie.md): one pure Jessie module whose completion is an
// arrow from a JSON value to a JSON value, metered by fuel. PostgreSQL runs it in
// plv8 under SES, as it runs a Mecha reducer's rules; the edge object runs the same
// instrumented module through pgl_step (mecha-edge's machines.ts).
import { jessieFacts, splitCompletion } from "./jessie.ts";
import type { Terminal } from "./mecha-reducer.ts";

export const FUNCTION_NAME = /^[a-z][a-z0-9_]{0,30}$/;
/** The schema holding each tier's engine; `public.fn_<name>` is the name callers use. */
export const FUNCTION_SCHEMA = "pronto_functions";
/** The host step a function answers to on the edge, apart from any machine's name. */
export const functionStep = (name: string) => `fn:${name}`;

export type DatabaseFunction = { name: string; fuel: number; endowments?: string[] };

/** Refuses the declaration or the module, and answers the module's statements
 * and completion, both instrumented for fuel. */
export function functionModule(spec: DatabaseFunction, source: string, terminal: Pick<Terminal, "instrument">): { statements: string; completion: string } {
  if (!FUNCTION_NAME.test(spec.name)) throw new Error(`invalid function name ${spec.name}`);
  if (!Number.isSafeInteger(spec.fuel) || spec.fuel < 1 || spec.fuel > 1000000) throw new Error(`function ${spec.name}: invalid fuel ${spec.fuel}`);
  if (spec.endowments?.length) throw new Error(`function ${spec.name}: endowments are not supported`);
  const facts = jessieFacts(source, "function");
  if (facts.references.length) throw new Error(`function ${spec.name} reaches ${facts.references.join(", ")}`);
  if (facts.completion !== "arrow") throw new Error(`function ${spec.name}: the module must end in an arrow function`);
  const module = splitCompletion(terminal.instrument(source));
  if (module === null) throw new Error(`function ${spec.name}: the instrumented module lost its arrow completion`);
  return module;
}

/** What both tiers run around the module: the argument detached and frozen,
 * and an answer that is not plain JSON refused rather than coerced. */
export const PLAIN = `(value, where = 'answer') => {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number') { if (Number.isFinite(value)) return value; throw new TypeError(where + ' is not a finite number') }
  if (Array.isArray(value)) { value.forEach((v, i) => plain(v, where + '[' + i + ']')); return value }
  if (typeof value === 'object' && [Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    for (const [k, v] of Object.entries(value)) plain(v, where + '.' + k)
    return value
  }
  throw new TypeError(where + ' is not JSON')
}`;

export function compileFunction(spec: DatabaseFunction, source: string, terminal: Terminal): string {
  const module = functionModule(spec, source, terminal);
  const script = `${module.statements}\n(${module.completion})`;
  const body = `
if (!globalThis.__prontoHybridSES) {
  ${terminal.ses}
  lockdown({errorTaming: 'unsafe'});
  Object.defineProperty(globalThis, '__prontoHybridSES', {value: true});
}
const plain = ${PLAIN};
let spent = 0;
const meter = harden(() => { if (++spent > ${spec.fuel}) throw new RangeError('function ${spec.name}: fuel exhausted'); });
const cage = new Compartment();
Object.defineProperty(cage.globalThis, '__fuel', {value: meter, writable: false, configurable: false});
const fn = cage.evaluate(${JSON.stringify(script)});
return plain(fn(harden(JSON.parse(JSON.stringify(input)))));
`;
  let tag = "$function$";
  while (body.includes(tag)) tag = tag.slice(0, -1) + "_$";
  const engine = `${FUNCTION_SCHEMA}.${spec.name}`;
  return `
-- tier: any
CREATE SCHEMA IF NOT EXISTS ${FUNCTION_SCHEMA};
REVOKE ALL ON SCHEMA ${FUNCTION_SCHEMA} FROM PUBLIC;
-- The engine is the tier's: plv8 here, inside the fence; the edge object creates
-- it over its host import when it boots (mecha-edge's machines.ts); the browser
-- tier has none, so a call there fails. plpgsql resolves it when called.
-- tier: container
CREATE EXTENSION IF NOT EXISTS plv8;
CREATE OR REPLACE FUNCTION ${engine}(input jsonb) RETURNS jsonb LANGUAGE plv8 AS ${tag}${body}${tag};
REVOKE ALL ON FUNCTION ${engine}(jsonb) FROM PUBLIC;
-- tier: any
-- Pure, so any caller may run it; the definer only reaches the engine.
CREATE OR REPLACE FUNCTION public.fn_${spec.name}(input jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog AS $fn$
BEGIN RETURN ${engine}(input); END;
$fn$;
`;
}
