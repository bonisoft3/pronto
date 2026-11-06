SELECT result.c0 AS "renamed", result.c1 AS "Other" FROM (SELECT t.c0 AS c0, t.c1 AS c1 FROM (SELECT "x" AS c0, "y" AS c1 FROM "t") t) result;
