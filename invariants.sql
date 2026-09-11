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

-- The literals no hatch excuses, joined on the declaration ordinal both tables
-- carry (styles.ts Decl.decl says why). A reason the enum does not know excuses
-- nothing. The literal rules below read this instead of each
-- restating it.
CREATE OR REPLACE VIEW unexcused_literal AS
SELECT l.* FROM app_literal l
WHERE NOT EXISTS (SELECT 1 FROM literal_exception e
                  JOIN exception_reason r ON r.reason = e.reason
                  WHERE e.path = l.path AND e.decl = l.decl);

-- The debt the budget counts: one row per pending hatch whose declaration
-- carries a literal a hatch can excuse. A root font-size is a contradiction the
-- ROOT_PX rule reports whatever wears it, so a hatch over one is not debt.
-- Stated once, so the budget rule and its message cannot drift.
CREATE OR REPLACE VIEW pending_debt AS
SELECT e.* FROM literal_exception e
WHERE e.reason = 'pending'
  AND EXISTS (SELECT 1 FROM app_literal l
              WHERE l.path = e.path AND l.decl = e.decl AND l.dimension <> 'root');

-- LOOSE against CLOSED. A diagram labels its nodes `Article (server)`, and the
-- tier is a claim about durability: a row that dies with the tab and a row that
-- outlives the device are different promises to the reader.
--
-- Any kind, not only a tier the enum still lists. Gating on that list would let
-- a renamed tier pass as an unrecognized word, which is how a rename disables
-- the check that guards it. A node carrying no kind is not a claim, and NULL
-- fails the comparison on its own.
SELECT 'error' AS severity,
       'ir.html' AS path,
       'diagram draws ' || d.name || ' as (' || d.kind || '), program declares ' || e.durability AS message
FROM diagram_node d
JOIN entity e ON e.name = d.name
WHERE d.kind <> e.durability

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
WHERE d.kind IN ('server', 'live', 'tab', 'device', 'offline')
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
-- palette. A stylesheet that declares one of those names again has two copies of
-- a colour that will not stay equal.
SELECT DISTINCT 'error',
       s.path,
       s.token || ' is declared by the shared style layer; redeclaring it here forks the '
         || 'design system. Consume it with var(' || s.token || ').'
FROM app_token s
JOIN owned_token o ON o.token = s.token

UNION ALL

-- CLOSED against CLOSED. The scale block publishes a length under a name; a
-- stylesheet that writes the same length as a literal in the same dimension has
-- a second copy of a value the scale already owns, and the two will not stay
-- equal. The rule fires only where a step EXISTS, so a value the vocabulary has
-- no name for is not a finding — extending the scale is what extends this rule,
-- which is why adding a step is a decision.
--
-- `warning`, not `error`, and this is the one severity in this file that is
-- scheduled rather than permanent: the rule grades a corpus the migration has
-- not reached, and a gate the corpus cannot satisfy is a gate it will route
-- around. It becomes `error` when every app reports zero — scoping it per
-- app would be a loophole, ordering the migration is not.
SELECT DISTINCT 'warning',
       l.path,
       l.value || ' in ' || l.prop || ' is ' || s.token
         || '. Consume it with var(' || s.token || ').'
FROM unexcused_literal l
JOIN scale_step s ON s.norm = l.norm AND s.dimension = l.dimension

UNION ALL

-- A hairline or a corner keyed to the font size is almost always a mistake, and no
-- ROOT_PX can normalise it into a rung, so `em` carries a norm no step publishes
-- and is refused in `rule` and `radius`. A type size keyed to the inherited one
-- (`em`, `%`, `ch`) is comparable to no rung and reports the same way. In `space`
-- it is untracked: text rhythm keyed to the text's own size is what `em` is for.
SELECT DISTINCT 'warning',
       l.path,
       l.value || ' keys a ' || l.dimension || ' to the font size, which no rung can name'
FROM unexcused_literal l
WHERE l.norm = 'em'

UNION ALL

-- Elevation is the one dimension where matching by value is the wrong test: a
-- shadow list is not a length, so its geometry is not joined. Its INK is, and
-- the seven twinned shadow-ink roles exist precisely so that no stylesheet
-- writes a black by hand. A colour reached through a token — realworld's and
-- thenote's color-mix() focus rings — never reaches this table.
SELECT DISTINCT 'warning',
       l.path,
       l.prop || ' inks ' || l.value || ' by hand; the shadow-ink roles carry both appearances'
FROM unexcused_literal l
WHERE l.dimension = 'shadow-color'

UNION ALL

-- The `font` shorthand sets size, leading, weight and family in one declaration
-- and no rule here can read any of them: the row joins nothing, so a size the
-- ladder names would pass unrefused wherever it is written this way. Not an
-- error, because writing the longhands is a change to a stylesheet the
-- migration has not reached; `inherit` and a bare var() set nothing this rule
-- could have refused, so neither reports.
SELECT DISTINCT 'warning',
       l.path,
       'line ' || l.line || ': `font: ' || l.value || '` sets size, leading, weight and '
         || 'family at once and no rule here can read any of them; write the longhands'
FROM unexcused_literal l
WHERE l.dimension = 'shorthand'
  AND lower(trim(l.value)) <> 'inherit'
  AND NOT regexp_matches(trim(l.value), '^var\([^()]*\)$')

UNION ALL

-- The length rules' own precondition, which styles.ts's ROOT_PX states and this
-- refuses to assume: an app that set a font-size on the root would silence every
-- rem-against-px comparison above. Not excusable, because a hatch here would
-- silence everything else.
SELECT 'error',
       l.path,
       'font-size ' || l.value || ' on the root element moves ROOT_PX, and every rem rung '
         || 'is compared to a px literal through it'
FROM app_literal l
WHERE l.dimension = 'root'

UNION ALL

-- A rule whose fact table can be empty reports zero findings, which reads as
-- green. Both sides of the join above come from one cue export, and emptiness is
-- an error rather than a silent pass.
--
-- `kind = 'rung'` because the design block's roles alone would keep the table
-- non-empty: every app declares roles, so a vocabulary that stopped arriving
-- entirely would still publish steps and this guard would read green over a
-- literal rule that had lost every rung it refuses toward.
SELECT 'error',
       'plugins/pronto/schema.cue',
       'the scale published no rungs at all, so the literal rule can report nothing'
WHERE NOT EXISTS (SELECT 1 FROM scale_step WHERE kind = 'rung')

UNION ALL

-- The same guard for the emission's own rows, which every rule over design.css
-- below reads.
SELECT 'error',
       'plugins/pronto/emit.cue',
       'the emission declares no tokens at all, so every rule over design.css can report nothing'
WHERE NOT EXISTS (SELECT 1 FROM design_declaration)

UNION ALL

-- The same guard for the vendored bytes, the table whose purpose is that a
-- vocabulary cannot quietly stop quoting anything.
SELECT 'error',
       'plugins/pronto/scales',
       'no vendored vocabulary declares anything, so the quotation rule can report nothing'
WHERE NOT EXISTS (SELECT 1 FROM vendor_declaration)

UNION ALL

-- The same guard for the scale's own side of the quotation: a scale that quoted
-- nothing would satisfy every rule below by having nothing to be held against.
-- Keyed on a tree answering a composed source name rather than on `kind`, as
-- THE WITNESS below is.
SELECT 'error',
       'plugins/pronto/schema.cue',
       'the scale draws from no vendored tree at all, so every rule below that joins a vendored tree can report nothing'
WHERE NOT EXISTS (SELECT 1 FROM scale_source s JOIN vendor_source v ON v.name = s.name)

UNION ALL

-- THE PROVENANCE. The witness and the admission both exempt a source no tree
-- answers, which is right for a source claiming no upstream and wrong for one
-- claiming an archive: `quoted` with no tree behind it publishes a whole ladder
-- graded by nobody's bytes. This is the rule that makes `kind` honest, and it is
-- the only query in this file that reads it — CUE cannot see the filesystem, so
-- the claim and the archive can only be joined here.
--
-- Keyed on the source row rather than on a published step, so a fabrication is
-- convicted before it grows a bucket. One-directional: a tree no source composes
-- stays legitimate, because registering and adopting are separate acts.
SELECT 'error',
       'plugins/pronto/schema.cue',
       s.name || ' quotes ' || s.origin || ' ' || s.version
         || ', and no tree under scales/ answers that name'
FROM scale_source s
WHERE s.kind = 'quoted'
  AND NOT EXISTS (SELECT 1 FROM vendor_source v WHERE v.name = s.name)

UNION ALL

-- THE QUOTATION. A generator cannot be proven to have READ a file; its output
-- can be proven equal to one, and that is a join. Every published step carries
-- the bytes of the source ITS OWN BUCKET names, so a table typed or generated
-- from nothing is wrong the moment the archive moves — which is the only moment
-- at which the two can disagree.
--
-- Joined on (source, token) rather than on the name alone. Two archives sharing
-- a name is not hypothetical — every vendor spells --text-* and --radius-* —
-- and under a name-only join a step would be graded against whichever tree
-- happened to declare it, which is right only for as long as no two do.
SELECT 'error',
       'plugins/pronto/schema.cue',
       p.token || ' is published as ' || p.value || ', and ' || s.origin || ' '
         || s.version || ' declares it ' || v.value
FROM scale_declaration p
JOIN scale_source s ON s.name = p.source
JOIN vendor_declaration v ON v.source = p.source AND v.token = p.token
WHERE v.value <> p.value

UNION ALL

-- THE WITNESS. The quotation above is a join, and a join is silent about a row
-- that matches nothing: a step under a vendor's prefix that the vendor never
-- declared would be graded by no archive at all. So a quoted source must
-- declare every name published from it.
--
-- The exemption is that NO VENDORED TREE ANSWERS THE NAME, which is a fact about
-- what is on disk. Never `kind`, which is authored (#Source in
-- schema.cue says why). The two buckets that legitimately have no upstream are answered by
-- no tree: the six shadow rungs, whose geometry is quoted but whose colour is
-- composed over this platform's own twinned inks, and the touch floor, which is
-- the terminal's measurement.
SELECT 'error',
       'plugins/pronto/schema.cue',
       p.token || ' is published from ' || s.origin || ' ' || s.version
         || ', which declares no such name; a step with no upstream names an own source'
FROM scale_declaration p
JOIN scale_source s ON s.name = p.source
WHERE EXISTS (SELECT 1 FROM vendor_source v WHERE v.name = p.source)
  AND NOT EXISTS (SELECT 1 FROM vendor_declaration v
                  WHERE v.source = p.source AND v.token = p.token)

UNION ALL

-- THE CONTRADICTION. A refusal is an argument for NOT quoting a name, so a file
-- cannot both refuse a token and publish it. Left unsaid, one appended refusal
-- row would take a published token out of the quotation's reach and the scale
-- could then say anything about its value.
SELECT 'error',
       'plugins/pronto/scales',
       p.token || ' is published, and ' || s.origin || ' ' || s.version
         || '''s admitted.json refuses it: ' || x.reason
FROM scale_declaration p
JOIN scale_source s ON s.name = p.source
JOIN vendor_exclusion x ON x.source = p.source
WHERE regexp_matches(p.token, x.pattern)

UNION ALL

-- THE ADMISSION, the other direction, and the reason the quotation rule is not
-- satisfied by quoting nothing: a name the archive declares is published under
-- it, or it is refused with an argument a reviewer can read.
--
-- Scoped to the sources #scale COMPOSES, which is what keeps registering a tree
-- cheap: a registration has its bytes verified and its buckets generated, and
-- until a bucket is drawn from it there is nothing for its names to be admitted
-- into.
SELECT 'error',
       'plugins/pronto/scales',
       s.origin || ' ' || s.version || ' declares ' || v.token
         || ', which this scale neither publishes nor refuses'
FROM (SELECT DISTINCT source, token FROM vendor_declaration) v
JOIN vendor_source s ON s.name = v.source
JOIN scale_source c ON c.name = v.source
WHERE NOT EXISTS (SELECT 1 FROM scale_declaration p
                  WHERE p.source = v.source AND p.token = v.token)
  AND NOT EXISTS (SELECT 1 FROM vendor_exclusion x
                  WHERE x.source = v.source AND regexp_matches(v.token, x.pattern))

UNION ALL

-- CLOSED against CLOSED. #scale is the vocabulary every identity is spelled in,
-- and it has no app seam — so the rung block is not merely derived from it, it
-- IS it. Holding each app's block equal to that one source is what makes the
-- block the same in all of them; a per-app lint cannot compare two apps, and once
-- this holds it does not need to. It is also the rule that
-- catches a step published to the lint that the CSS never declares, which would
-- send an author to a token that resolves to nothing.
SELECT 'error',
       'shell/design.css',
       '#scale publishes ' || p.token || ': ' || p.value || ', which the rung block does not declare'
FROM scale_declaration p
WHERE NOT EXISTS (SELECT 1 FROM design_declaration d
                  WHERE d.block = ':where(html)' AND d.token = p.token AND d.value = p.value)

UNION ALL

SELECT 'error',
       'shell/design.css',
       'the rung block declares ' || d.token || ', which #scale does not publish'
FROM design_declaration d
WHERE d.block = ':where(html)'
  AND NOT EXISTS (SELECT 1 FROM scale_declaration p WHERE p.token = d.token)

UNION ALL

-- A colour in the scale is how the closedness would be lost: a rung has no
-- appearance, so it has no twin, and a colour written there would be one
-- appearance with no way to state the other.
SELECT 'error',
       'shell/design.css',
       d.token || ' carries a colour of its own (' || d.value || '), and a rung has no appearance'
FROM design_declaration d
WHERE d.block = ':where(html)' AND d.colored

UNION ALL

-- The emitter owns two blocks and the whole vocabulary is declared in them, so
-- a `[data-theme]` sibling palette, a `.dark` class fork or any third block
-- carrying a token cannot exist. `.screen[data-state$="-dark"]` sets
-- `color-scheme` and no token, which is why it needs no exemption here: an
-- appearance is a resolution of these declarations, never a second set of them.
SELECT DISTINCT 'error',
       'shell/design.css',
       d.token || ' is declared under ' || d.block
         || ', which forks the vocabulary the :root and :where(html) blocks own'
FROM design_declaration d
WHERE d.block NOT IN (':root', ':where(html)')

UNION ALL

-- A token reaching for one nothing declares is invalid at computed-value time,
-- which is silent: the declaration simply does not apply. #shadowInks closes that
-- for the inks by construction; this closes it for anything added later,
-- including the ease aliases, which name steps inside the rung block.
--
-- Both emitted blocks, not just the rungs. :root is where the tiers that exist to
-- point at another token are emitted — --c-*, --control-pad-x — and scaleSteps
-- raises on a dangling reference only for what #Design declares, so a reference
-- the EMITTER introduced would otherwise be read by nothing.
SELECT 'error',
       'shell/design.css',
       r.token || ' reaches for ' || r.ref || ', which neither emitted block declares'
FROM design_reference r
WHERE r.block IN (':root', ':where(html)')
  AND NOT EXISTS (SELECT 1 FROM design_declaration d
                  WHERE d.token = r.ref AND d.block IN (':root', ':where(html)'))

UNION ALL

-- CLOSED against CLOSED. The program declares what the image carries, and a
-- browser resolves an `@import` against the importing sheet's own URL and drops
-- a 404 in silence — so a dead import renders exactly like a live one and no
-- other rule here can see it: none of them follows an import.
SELECT 'error',
       'plugins/pronto/emit.cue',
       'the image carries no files at all, so the import rule can report nothing'
WHERE NOT EXISTS (SELECT 1 FROM served_file)

UNION ALL

SELECT 'error',
       i.path,
       'line ' || i.line || ': @import ' || i.target || ' names '
         || coalesce(i.resolved, 'no path the image can carry')
         || ', which nothing serves'
FROM app_import i
WHERE i.resolved IS NULL
   OR NOT EXISTS (SELECT 1 FROM served_file s WHERE s.target = i.resolved)

UNION ALL

-- CLOSED against CLOSED. The hatch's reasons are an enum, and an unrecognised
-- one excuses nothing: an escape hatch is only honest if its reasons are
-- checkable, and `physical` is self-consistent, uncapped, and claimable over the
-- largest population the rule exists to police — which is why it is not one.
SELECT 'error',
       e.path,
       'pronto-literal: ' || e.reason || ' is not a reason; the enum is '
         || (SELECT string_agg(reason, ' | ' ORDER BY reason) FROM exception_reason)
FROM literal_exception e
WHERE NOT EXISTS (SELECT 1 FROM exception_reason r WHERE r.reason = e.reason)

UNION ALL

-- `derived` claims the value is arithmetically tied to another token where
-- calc() cannot express it. A block that references no token at all has no
-- subject for that claim.
SELECT 'error',
       e.path,
       'pronto-literal: derived on line ' || e.line || ', in a block that references no token'
FROM literal_exception e
WHERE e.reason = 'derived' AND NOT e.witnessed

UNION ALL

-- EQUALITY, not a ceiling. Fixing a site without lowering the number fails,
-- adding one without raising it fails, and raising it is a diff in program.cue a
-- reviewer sees. Debt is strictly monotone downward. Debt is a pending hatch
-- over a declaration that carries a literal: an orphan hatch, or one over a
-- declaration already on a token, excuses nothing, so the ledger below prints
-- it and a fixed site whose comment was left behind lowers the number rather
-- than holding it.
SELECT 'error',
       'program.cue',
       'meta.design.pendingLiterals is ' || b.pending_literals || ', and '
         || (SELECT count(*) FROM pending_debt)
         || ' literal-bearing declarations wear /* pronto-literal: pending */'
FROM design_budget b
WHERE b.pending_literals <> (SELECT count(*) FROM pending_debt)

UNION ALL

-- Not a finding: the ledger. Every use of the hatch is printed with the
-- findings, so the escape is visible rather than silent and the population is
-- countable without reading the stylesheets.
SELECT 'warning',
       e.path,
       'line ' || e.line || ': ' || coalesce(e.prop, 'no declaration')
         || ' is excused by /* pronto-literal: ' || e.reason || ' */'
FROM literal_exception e

UNION ALL

-- CLOSED against CLOSED. The list holds only what the compartment lets through
-- — names that reach an evaluator — so each entry carries its own reason and
-- the reason travels with the name rather than with the query.
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
