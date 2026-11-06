WITH "__duckstream_0" AS (SELECT CAST(COUNT(t.c0) AS BIGINT) AS c0 FROM (SELECT t.c0 AS c0 FROM (SELECT "x" AS c0 FROM "t") t GROUP BY t.c0) t)
SELECT CAST(result.c0 AS BIGINT) AS "n" FROM (SELECT v.c0 AS c0 FROM "__duckstream_0" v) result;
