CREATE TABLE fixtures_game(id INTEGER NOT NULL, team VARCHAR, moment TIMESTAMP);
CREATE TABLE fixtures_rating(team VARCHAR NOT NULL, moment TIMESTAMP NOT NULL, power DOUBLE NOT NULL);
CREATE MATERIALIZED VIEW result AS
SELECT g.id, r.power FROM fixtures_game g
LEFT ASOF JOIN fixtures_rating r MATCH_CONDITION (g.moment >= r.moment)
ON g.team = r.team;
