CREATE TABLE src(a BIGINT, b BIGINT);
CREATE VIEW result AS SELECT a / b AS quotient FROM src;
