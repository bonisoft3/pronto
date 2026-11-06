CREATE TABLE substring_source(id INTEGER NOT NULL, s VARCHAR, first BIGINT, width INTEGER);
CREATE VIEW result AS
SELECT id, SUBSTRING(s FROM first) AS suffix,
       SUBSTRING(s FROM first FOR width) AS part
FROM substring_source;
