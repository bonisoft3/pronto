CREATE TABLE events (id INTEGER NOT NULL PRIMARY KEY, ts TIMESTAMP NOT NULL, amount BIGINT NOT NULL);
CREATE VIEW result AS
SELECT window_start, window_end, COUNT(*) AS event_count, SUM(amount) AS total
FROM TABLE(TUMBLE(TABLE events, DESCRIPTOR(ts), INTERVAL '5' MINUTE))
GROUP BY window_start, window_end;
