CREATE MATERIALIZED VIEW totals AS
SELECT a.id, a.label, a.revision AS account_revision,
       COUNT(*) AS n, SUM(e.amount) AS total, MAX(e.revision) AS event_revision
FROM account a JOIN event e ON a.id = e.account_id
GROUP BY a.id, a.label, a.revision;

CREATE MATERIALIZED VIEW tumbling AS
SELECT window_start, window_end, COUNT(*) AS n, SUM(amount) AS total
FROM TABLE(TUMBLE(TABLE event, DESCRIPTOR(happened), INTERVAL '5' SECOND))
GROUP BY window_start, window_end;

CREATE TABLE timed (id INTEGER NOT NULL, happened TIMESTAMP NOT NULL LATENESS INTERVAL '2' SECOND,
                    amount INTEGER NOT NULL) WITH ('materialized' = 'true');

CREATE MATERIALIZED VIEW final_windows WITH ('emit_final' = 'window_end') AS
SELECT window_start, window_end, COUNT(*) AS n, SUM(amount) AS total
FROM TABLE(TUMBLE(TABLE timed, DESCRIPTOR(happened), INTERVAL '5' SECOND))
GROUP BY window_start, window_end;

CREATE MATERIALIZED VIEW hopping AS
SELECT window_start, window_end, COUNT(*) AS n, SUM(amount) AS total
FROM TABLE(HOP(TABLE event, DESCRIPTOR(happened), INTERVAL '5' SECOND, INTERVAL '10' SECOND))
GROUP BY window_start, window_end;
