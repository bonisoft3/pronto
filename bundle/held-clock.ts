// A page under a held clock (omnishell's ?clock=manual) runs its row machines
// on it. The cluster keeps the held instant in the session's `mecha.clock`
// (mecha-browser's cluster.ts); here the machine's clock reads it, falling
// back to the transaction's time where it is unset. Only the page's PGlite
// runs this: one user in one tab, so a clock the session sets carries no
// server's weight, and no server tier's machine_clock() changes.
export const HELD_MACHINE_CLOCK = `CREATE OR REPLACE FUNCTION machine_clock() RETURNS timestamptz
LANGUAGE sql STABLE SET search_path = pg_catalog AS $clock$
SELECT coalesce(nullif(current_setting('mecha.clock', true), '')::timestamptz, transaction_timestamp());
$clock$;
REVOKE ALL ON FUNCTION machine_clock() FROM PUBLIC;`

const DECLARES = /CREATE OR REPLACE FUNCTION machine_clock\(\)/

/** The page's scripts with the machine's clock pointed at the held instant,
 * right after the script that declares it, so a seed that enters a timed
 * state arms on the held instant too. */
export const heldClock = (sql: string[]): string[] => sql.flatMap((s) => DECLARES.test(s) ? [s, HELD_MACHINE_CLOCK] : [s])
