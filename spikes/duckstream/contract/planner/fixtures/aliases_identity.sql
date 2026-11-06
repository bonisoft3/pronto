CREATE TABLE t (x INTEGER, y BIGINT);
CREATE VIEW result AS SELECT x AS renamed, y AS "Other" FROM t;
