CREATE TABLE union_source(id INTEGER, label VARCHAR);
CREATE LOCAL VIEW literal_rows AS
SELECT * FROM (VALUES (0, CAST('zero' AS VARCHAR)), (1, CAST('one' AS VARCHAR)), (1, CAST('one' AS VARCHAR))) AS v(id, label);
CREATE LOCAL VIEW distinct_rows AS
SELECT * FROM literal_rows UNION SELECT * FROM literal_rows;
CREATE VIEW result AS
SELECT * FROM union_source UNION ALL SELECT * FROM distinct_rows;
