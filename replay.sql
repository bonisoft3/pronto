-- What one migration did to the one before it, read out of the catalog.
--
-- The join is on the relation's identity and the physical column number, never
-- the name. Within one relation Postgres keeps attnum across a rename and never
-- hands it to another column after a drop, so a name that moved under a living
-- attnum is a rename, and a name that left with its attnum is a loss. That is
-- the whole reason this pass exists beside squawk: a rename spelled inside a
-- DO $$ ... $$ block, or by dynamic EXECUTE, is invisible to anything reading
-- the SQL and lands in the catalog exactly like a plain one.
--
-- The oid is carried because that invariant is a statement about one relation
-- and nothing more. DROP TABLE t; CREATE TABLE t starts attnum over at 1, so
-- matched on name and number alone the new table's columns pair with the dead
-- table's: an identical recreate reads as no change at all, and a differing one
-- reads as a rename — a message about JSON keys for an event that destroyed
-- every row. A relation that ends is therefore reported in its own right, and
-- only the relations that survive have their columns compared.
--
-- `step` names every migration applied, including the ones that left no column
-- behind; `snapshot` holds only what the catalog had after each. They are two
-- tables because a migration that drops the last table appears in neither the
-- state before it nor the state after, and deriving the step list from the
-- snapshot would leave exactly that migration — the most destructive one there
-- is — as the only one a finding could not name.
--
-- Additions are not reported, which is why this reads from the earlier state
-- outward: a table or a column that appears is what a migration is for, and it
-- is what disappears, moves or changes type that costs a holder something.

WITH last AS (SELECT max(step) AS n FROM step),

-- Each state's relations, by identity and by the name it answered to.
rels AS (SELECT DISTINCT step, rel, tbl FROM snapshot),

-- A relation the next state no longer has. Whether its name was taken up by a
-- new relation decides only which sentence is printed: the rows are gone either
-- way, and the recreate is the more dangerous of the two because the schema
-- that follows it can look untouched.
lost_rel AS (
  SELECT p.step + 1 AS step,
         p.tbl      AS tbl,
         EXISTS (SELECT 1 FROM rels s WHERE s.step = p.step + 1 AND s.tbl = p.tbl) AS reused_name
    FROM rels p
   WHERE p.step < (SELECT n FROM last)
     AND NOT EXISTS (SELECT 1 FROM rels s WHERE s.step = p.step + 1 AND s.rel = p.rel)
),

-- Columns of the relations that did survive, each beside what the next state
-- made of it. The outer join keeps a column the later step no longer has, which
-- is the case worth reporting.
pairs AS (
  SELECT p.step + 1 AS step,
         p.tbl      AS tbl,
         p.ordinal  AS ordinal,
         p.col      AS was_col, s.col AS now_col,
         p.typ      AS was_typ, s.typ AS now_typ
    FROM snapshot p
    LEFT JOIN snapshot s
      ON p.rel = s.rel AND p.ordinal = s.ordinal AND s.step = p.step + 1
   WHERE p.step < (SELECT n FROM last)
     AND EXISTS (SELECT 1 FROM rels r WHERE r.step = p.step + 1 AND r.rel = p.rel)
)

SELECT severity, path, message FROM (
  SELECT 'error' AS severity,
         (SELECT mig FROM step WHERE step.step = lost_rel.step) AS path,
         step, tbl, 0 AS ordinal,
         CASE
           WHEN reused_name THEN
             tbl || ' was dropped and recreated: the table standing here now is a different one, ' ||
             'so every row the old one held is gone — a table is altered, never replaced'
           ELSE
             tbl || ' is gone: every row it held is gone with it, and every holder still reading it breaks'
         END AS message
    FROM lost_rel

  UNION ALL

  SELECT 'error' AS severity,
         (SELECT mig FROM step WHERE step.step = pairs.step) AS path,
         step, tbl, ordinal,
         CASE
           WHEN now_col IS NULL THEN
             tbl || '.' || was_col || ' (column ' || ordinal || ') is gone: a column retires, it is never dropped — every holder still reading it breaks'
           WHEN was_col <> now_col THEN
             tbl || '.' || was_col || ' (column ' || ordinal || ') was renamed to ' || now_col ||
             ': the JSON a holder reads is keyed by name, so a rename breaks readers a rollout has not reached yet'
           ELSE
             tbl || '.' || now_col || ' (column ' || ordinal || ') was ' || was_typ || ' and is ' || now_typ ||
             ': a type change is a retirement beside an addition'
         END AS message
    FROM pairs
   WHERE now_col IS NULL OR was_col <> now_col OR was_typ <> now_typ
) ORDER BY step, tbl, ordinal;
