WITH "__duckstream_0" AS (SELECT CAST(COUNT(*) AS BIGINT) AS c0, CAST(SUM(t.c0) AS BIGINT) AS c1 FROM (SELECT t.c2 AS c0 FROM (SELECT "id" AS c0, "ts" AS c1, "amount" AS c2 FROM "events") t) t)
SELECT CAST(result.c0 AS BIGINT) AS "n", CAST(result.c1 AS BIGINT) AS "total" FROM (SELECT v.c0 AS c0, v.c1 AS c1 FROM "__duckstream_0" v) result;
