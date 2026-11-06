SELECT "window_start", "window_end", COUNT(*) AS "event_count", SUM("amount") AS "total"
FROM TABLE(HOP((SELECT *
FROM "schema"."events"), DESCRIPTOR("ts"), INTERVAL '5' MINUTE, INTERVAL '10' MINUTE))
GROUP BY "window_start", "window_end";
