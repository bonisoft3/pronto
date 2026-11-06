CREATE TABLE calendar_inputs(id INTEGER NOT NULL, instant TIMESTAMP(6));
CREATE VIEW result AS SELECT id,
 FLOOR(instant TO MONTH) AS month_start,
 FLOOR(instant TO MONTH) + INTERVAL '-7' YEAR AS history_start,
 instant + INTERVAL '-1' YEAR AS prior_year
FROM calendar_inputs;
