SELECT "window_start", "window_end", COUNT(*) AS "event_count", SUM("amount") AS "total"
FROM TABLE(TUMBLE((SELECT *
FROM "schema"."events"), DESCRIPTOR("ts"), INTERVAL '5' MINUTE))
GROUP BY "window_start", "window_end";
