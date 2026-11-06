WITH "__duckstream_0" AS (SELECT t.c0 AS c0 FROM (SELECT "label" AS c0 FROM "search_source") t WHERE (t.c0 IN ('day', 'week', 'é😀')))
SELECT CAST(result.c0 AS VARCHAR) AS "label" FROM (SELECT v.c0 AS c0 FROM "__duckstream_0" v) result;
