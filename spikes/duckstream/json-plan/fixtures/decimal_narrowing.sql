CREATE TABLE money(amount DECIMAL(18,2));
CREATE VIEW result AS SELECT CAST(amount AS DECIMAL(18,1)) AS total FROM money;
