-- Invariants over .pronto/facts.json. Authored and reviewed; never generated —
-- a check that cannot be read is worth less than the tree-walk it replaced.
--
-- check-facts.ts creates one view per fact table and runs this file. Every
-- query yields (severity, path, message); no rows means the invariant holds.
--
-- Each query states the modality it reads, because that decides which of the
-- two anti-joins is a finding. A CLOSED fact comes from program.cue, whose
-- entity and screen sets are complete, so naming something outside them is a
-- contradiction. A LOOSE fact comes from ir.html, which may omit anything it
-- likes — so an ir claim with no witness is a finding, while a program fact no
-- diagram draws is not.

-- LOOSE against CLOSED. A diagram labels its nodes `Article (crud)`, and the
-- tier is a claim about durability: a row that dies with the tab and a row that
-- outlives the device are different promises to the reader.
SELECT 'error' AS severity,
       'ir.html' AS path,
       'diagram draws ' || d.name || ' as (' || d.kind || '), program declares ' || e.path AS message
FROM diagram_node d
JOIN entity e ON e.name = d.name
WHERE d.kind IN ('crud', 'live', 'tab', 'device', 'offline')
  AND d.kind <> e.path

UNION ALL

-- LOOSE against CLOSED. The screen set is complete, so a node labelled
-- `(screen)` that names none is drawn from nothing.
SELECT 'error',
       'ir.html',
       'diagram draws screen ' || d.name || ', which the program does not declare'
FROM diagram_node d
LEFT JOIN screen s ON s.name = d.name
WHERE d.kind = 'screen' AND s.name IS NULL

UNION ALL

-- LOOSE against CLOSED. The entity set is complete too, so a node wearing a
-- tier that names no entity is drawn from nothing. Separate from the tier
-- comparison above, which can only speak about names the program knows.
SELECT 'error',
       'ir.html',
       'diagram draws ' || d.name || ' as (' || d.kind || '), which the program declares no entity for'
FROM diagram_node d
LEFT JOIN entity e ON e.name = d.name
WHERE d.kind IN ('crud', 'live', 'tab', 'device', 'offline')
  AND e.name IS NULL

UNION ALL

-- CLOSED against CLOSED. A machine writes its state into a column, and that
-- column's cel may enumerate what it admits. A state outside the enumeration is
-- a row the store would refuse the moment the chart reached it.
SELECT 'error',
       'shell/screens/' || cs.screen || '.html',
       'chart writes ' || cs.field || ' = ' || cs.state || ', which the cel of '
         || e.name || '.' || cs.field || ' does not admit'
FROM chart_state cs
JOIN entity e ON e."table" = cs."table"
WHERE EXISTS (SELECT 1 FROM enum_value v WHERE v.entity = e.name AND v.field = cs.field)
  AND NOT EXISTS (
        SELECT 1 FROM enum_value v
        WHERE v.entity = e.name AND v.field = cs.field AND v.value = cs.state)

UNION ALL

-- A promise nothing settles, blamed on whichever rung is actually short. The ir
-- storyboards a screen's paths and program.cue declares them again, and `paths`
-- is optional program-side — so a claim settled only in the storyboard is a
-- program that has not formalised it, not a ledger that over-promised. Reported
-- per claim rather than per path, because the claim is what the gap costs.
SELECT 'warning',
       'program.cue',
       a.id || ' is accepted only by ir storyboard paths the program does not declare: '
         || string_agg(p.screen || '.' || p.name, ', ' ORDER BY p.screen, p.name)
FROM claim a
JOIN ir_path_accept p ON p.accept = a.id
WHERE a.rung = 'acceptance' AND a.kind = 'accept'
  AND NOT EXISTS (
        SELECT 1 FROM claim c
        WHERE c.kind = 'accept-citation' AND c.rung = 'program' AND c.id = a.id)
GROUP BY a.id

UNION ALL

SELECT 'warning',
       'acceptance.md',
       a.id || ' is promised and nothing accepts it — no test, no storyboard path'
FROM claim a
WHERE a.rung = 'acceptance' AND a.kind = 'accept'
  AND NOT EXISTS (
        SELECT 1 FROM claim c
        WHERE c.kind = 'accept-citation' AND c.rung = 'program' AND c.id = a.id)
  AND NOT EXISTS (SELECT 1 FROM ir_path_accept p WHERE p.accept = a.id)

UNION ALL

-- CLOSED against CLOSED, driven by `pairing`. Which sets two rungs must agree
-- about, and which direction of disagreement is a finding, are rows: a tenth
-- compared kind, or a new pair of rungs, is a row and not a query. The wording
-- is authored per pairing rather than generated, because what a finding says is
-- what makes it actionable.
SELECT p.severity,
       CASE p.rung_a WHEN 'program' THEN 'program.cue' WHEN 'ir' THEN 'ir.html' ELSE 'acceptance.md' END,
       p.noun || ' "' || a.id || '"' || coalesce(' (' || a.where || ')', '') || ' ' || p.a_missing
FROM pairing p
JOIN claim a ON a.kind = p.kind_a AND a.rung = p.rung_a
WHERE p.a_missing IS NOT NULL
  AND NOT EXISTS (
        SELECT 1 FROM claim b
        WHERE b.kind = p.kind_b AND b.rung = p.rung_b AND b.id = a.id)

UNION ALL

SELECT p.severity,
       CASE p.rung_b WHEN 'program' THEN 'program.cue' WHEN 'ir' THEN 'ir.html' ELSE 'acceptance.md' END,
       p.noun || ' "' || b.id || '"' || coalesce(' (' || b.where || ')', '') || ' ' || p.b_missing
FROM pairing p
JOIN claim b ON b.kind = p.kind_b AND b.rung = p.rung_b
WHERE p.b_missing IS NOT NULL
  AND NOT EXISTS (
        SELECT 1 FROM claim a
        WHERE a.kind = p.kind_a AND a.rung = p.rung_a AND a.id = b.id)

UNION ALL

-- The same miss where the ir does carry the id under another kind. Naming the
-- kind it found is the difference between "you forgot this" and "you filed it
-- wrong", so it stays its own query rather than a pairing row.
SELECT 'error',
       'program.cue',
       a.kind || ' "' || a.id || '" (' || a.where || ') is defined in ir.html as '
         || string_agg(DISTINCT b.kind, ', ')
FROM claim a
JOIN claim b ON b.rung = 'ir' AND b.id = a.id AND b.kind <> a.kind
WHERE a.rung = 'program'
  AND NOT EXISTS (SELECT 1 FROM claim x WHERE x.rung = 'ir' AND x.kind = a.kind AND x.id = a.id)
GROUP BY a.kind, a.id, a.where

UNION ALL

-- An id names one thing per rung, where it names anything at all: many ir tests
-- may cite one acceptance claim, so which (rung, kind) pairs are unique is a row
-- rather than an assumption.
SELECT 'error',
       CASE c.rung WHEN 'program' THEN 'program.cue' WHEN 'ir' THEN 'ir.html' ELSE 'acceptance.md' END,
       c.kind || ' "' || c.id || '" is stated ' || count(*) || ' times by ' || c.rung
FROM claim c
JOIN unique_claim u ON u.rung = c.rung AND u.kind = c.kind
GROUP BY c.rung, c.kind, c.id HAVING count(*) > 1

UNION ALL

-- A screen's route is stated on both rungs and must be the one route.
SELECT 'error',
       'ir.html',
       'screen "' || p.id || '" is routed ' || coalesce(p.route, '(none)')
         || ' by the program and ' || coalesce(i.route, '(none)') || ' by the ir'
FROM program_route p
JOIN ir_route i ON i.id = p.id
WHERE coalesce(i.route, '') <> coalesce(p.route, '')

UNION ALL

-- CLOSED against CLOSED. The parsed IR is checked in beside the constraints it
-- was parsed from, and the two name one set: a cel with no IR was edited without
-- regenerating, an IR nothing states is left over from one that was.
SELECT 'error',
       '.pronto/cel.json',
       s.entity || ' states cel ' || s.cel || ', which the checked-in IR has no entry for'
FROM cel_site s
WHERE NOT EXISTS (SELECT 1 FROM cel_ir i WHERE i.cel = s.cel)

UNION ALL

SELECT 'error',
       '.pronto/cel.json',
       'holds an IR for ' || i.cel || ', which no field or invariant states'
FROM cel_ir i
WHERE NOT EXISTS (SELECT 1 FROM cel_site s WHERE s.cel = i.cel)

UNION ALL

-- CLOSED against CLOSED. The emitter writes the program's design block into
-- shell/design.css, and the terminal ships shell.css; between them they own the
-- palette. A screen that declares one of those names again has two copies of a
-- colour that will not stay equal.
SELECT DISTINCT 'error',
       s.path,
       s.token || ' is declared by the shared style layer; redeclaring it here forks the '
         || 'design system. Consume it with var(' || s.token || ').'
FROM screen_token s
JOIN owned_token o ON o.token = s.token

UNION ALL

-- CLOSED against CLOSED. A Jessie module evaluates in an SES compartment with
-- no endowments, so a denied identifier would be undefined or nondeterministic
-- at runtime; the reason travels with the name rather than with the query.
SELECT 'error',
       r.path,
       'denylisted identifier: ' || r.name || ' (' || d.reason || ')'
FROM handler_reference r
JOIN denied_identifier d ON d.name = r.name

UNION ALL

-- The loader takes the compartment's completion value, so the last top-level
-- expression must BE that value. Which of the two shapes a module owes is its
-- role's business; this refuses one that is neither.
SELECT 'error',
       h.path,
       'the last top-level expression must be the module''s completion value — '
         || 'an arrow function (handler) or a parenthesised object literal (adapter)'
FROM handler h
WHERE h.completion = 'other'

ORDER BY path, message
