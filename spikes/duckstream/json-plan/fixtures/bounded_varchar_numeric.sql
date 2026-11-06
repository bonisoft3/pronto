CREATE TABLE values_to_format(n INTEGER);
CREATE VIEW result AS SELECT CAST(n AS VARCHAR(2)) AS shortened FROM values_to_format;
