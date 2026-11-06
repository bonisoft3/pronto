CREATE TABLE events (id INTEGER NOT NULL PRIMARY KEY, ts TIMESTAMP NOT NULL, amount BIGINT);
CREATE VIEW result AS
SELECT window_start, window_end, COUNT(*) AS n, SUM(amount) AS total
FROM TABLE(HOP(TABLE events, DESCRIPTOR(ts), INTERVAL '5' SECOND, INTERVAL '10' SECOND))
GROUP BY window_start, window_end;
