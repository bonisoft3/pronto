CREATE TABLE events (id INTEGER NOT NULL PRIMARY KEY, ts TIMESTAMP NOT NULL LATENESS INTERVAL '1' SECOND, amount BIGINT);
CREATE VIEW result WITH ('emit_final' = 'window_end') AS
SELECT window_start, window_end, COUNT(*) AS n, SUM(amount) AS total
FROM TABLE(TUMBLE(TABLE events, DESCRIPTOR(ts), INTERVAL '10' SECOND))
GROUP BY window_start, window_end;
