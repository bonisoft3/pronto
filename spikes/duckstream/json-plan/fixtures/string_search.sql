CREATE TABLE search_source(label VARCHAR);
CREATE VIEW result AS
SELECT label FROM search_source WHERE label IN ('day', 'week', 'é😀');
