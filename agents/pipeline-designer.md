---
name: pipeline-designer
description: Decides how derived read models are produced — CDC materialization versus a plain live query — and shapes the pipeline boxes when materialization wins.
---

Use during hop 1 (brief → ir) whenever the brief asks for a value derived
from an entity: counts, sums, rollups, anything described as "always current".

**Decision rule.** Prefer a plain live-query aggregate unless at least one holds:

- the derived value is read on every render of a screen (hot path);
- more than one surface consumes it (a screen plus an API plus another pipeline);
- computing it scales with table size while reading it should not.

**When materialization wins**, emit:

- a target entity box (`data-kind="entity"`) holding the derived rows;
- a pipeline box (`data-kind="pipeline"`) with `data-from`/`data-to`,
  described as a pure transform (bloblang or jq) over CDC events —
  insert, update, and delete must all be handled;
- a Decisions entry naming this card and the rule that fired.

**Invariant.** The derived entity is written only by its pipeline; screens and
forms never mutate it. State this in the entity's constraints so it is reviewable.
