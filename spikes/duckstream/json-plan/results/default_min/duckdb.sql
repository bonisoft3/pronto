WITH "__duckstream_0" AS (SELECT CAST(MIN(t.c0) AS BIGINT) AS c0 FROM (SELECT "x" AS c0 FROM "t") t)
SELECT CAST(result.c0 AS BIGINT) AS "total" FROM (SELECT v.c0 AS c0 FROM "__duckstream_0" v) result;
