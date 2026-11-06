CREATE TABLE values_to_format(t VARCHAR);
CREATE VIEW result AS SELECT CAST(t AS VARCHAR(2)) AS shortened FROM values_to_format;
