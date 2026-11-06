CREATE TABLE events (id INTEGER NOT NULL PRIMARY KEY, ts TIMESTAMP NOT NULL, amount BIGINT) WITH ('append_only' = 'true');
CREATE VIEW result AS
SELECT window_start, window_end, COUNT(*) AS n, SUM(amount) AS total
FROM TABLE(TUMBLE(TABLE events, DESCRIPTOR(ts), INTERVAL '10' SECOND))
GROUP BY window_start, window_end;
