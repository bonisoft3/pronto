CREATE TABLE applied (
    computation VARCHAR NOT NULL,
    program VARCHAR NOT NULL,
    epoch VARCHAR NOT NULL,
    snapshot BIGINT NOT NULL
);
CREATE TABLE lifecycle (
    computation VARCHAR NOT NULL,
    program VARCHAR NOT NULL,
    epoch VARCHAR NOT NULL,
    revision BIGINT NOT NULL,
    busy INTEGER NOT NULL,
    published_through BIGINT NOT NULL
);
CREATE VIEW result AS
WITH changes AS (
    SELECT computation, program, epoch, MAX(snapshot) AS target
    FROM applied
    GROUP BY computation, program, epoch
), revisions AS (
    SELECT computation, program, epoch, MAX(revision) AS revision
    FROM lifecycle
    GROUP BY computation, program, epoch
), latest AS (
    SELECT DISTINCT l.computation, l.program, l.epoch, l.revision,
        l.busy, l.published_through
    FROM lifecycle l JOIN revisions r
    ON l.computation = r.computation AND l.program = r.program
        AND l.epoch = r.epoch AND l.revision = r.revision
), state AS (
    SELECT c.computation, c.program, c.epoch, c.target,
        COALESCE(l.published_through, CAST(0 AS BIGINT)) AS covered,
        COALESCE(l.revision, CAST(0 AS BIGINT)) AS revision,
        COALESCE(l.busy, 0) AS busy
    FROM changes c
    LEFT JOIN latest l ON c.computation = l.computation
        AND c.program = l.program AND c.epoch = l.epoch
)
SELECT computation, program, epoch, target, covered, revision, busy,
    target > covered AS dirty,
    target > covered AND busy = 0 AS runnable
FROM state;
