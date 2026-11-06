WITH "__duckstream_0" AS (SELECT CAST(CAST(0 AS INTEGER) AS INTEGER) AS c0, CAST('zero' AS VARCHAR) AS c1 UNION ALL SELECT CAST(CAST(1 AS INTEGER) AS INTEGER) AS c0, CAST('one' AS VARCHAR) AS c1 UNION ALL SELECT CAST(CAST(1 AS INTEGER) AS INTEGER) AS c0, CAST('one' AS VARCHAR) AS c1),
"__duckstream_1" AS (SELECT t.c0 AS c0, t.c1 AS c1 FROM (SELECT v.c0 AS c0, v.c1 AS c1 FROM "__duckstream_0" v) t GROUP BY t.c0, t.c1),
"__duckstream_2" AS ((SELECT "id" AS c0, "label" AS c1 FROM "union_source") UNION ALL (SELECT v.c0 AS c0, v.c1 AS c1 FROM "__duckstream_1" v))
SELECT CAST(result.c0 AS INTEGER) AS "id", CAST(result.c1 AS VARCHAR) AS "label" FROM (SELECT v.c0 AS c0, v.c1 AS c1 FROM "__duckstream_2" v) result;
