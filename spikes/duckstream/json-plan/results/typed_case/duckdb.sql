WITH "__duckstream_0" AS (SELECT CAST((CASE WHEN (t.c0 IS NULL) THEN CAST(0 AS BIGINT) ELSE CAST(t.c0 AS BIGINT) END + CAST(1 AS INTEGER)) AS BIGINT) AS c0 FROM (SELECT "i" AS c0 FROM "typed_values") t)
SELECT CAST(result.c0 AS BIGINT) AS "total" FROM (SELECT v.c0 AS c0 FROM "__duckstream_0" v) result;
