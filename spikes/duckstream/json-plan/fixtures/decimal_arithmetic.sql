CREATE TABLE money(amount DECIMAL(18,2));
CREATE VIEW result AS SELECT amount + amount AS total FROM money;
