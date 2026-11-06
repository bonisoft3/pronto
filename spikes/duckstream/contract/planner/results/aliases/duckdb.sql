SELECT result.c0 AS "renamed", result.c1 AS "Other", result.c2 AS "again" FROM (SELECT t.c1 AS c0, t.c0 AS c1, t.c0 AS c2 FROM (SELECT "x" AS c0, "y" AS c1 FROM "t") t) result;
