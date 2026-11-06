CREATE TABLE t (x INTEGER, y BIGINT);
CREATE VIEW result AS
SELECT y AS renamed, x AS "Other", x AS again FROM t;
