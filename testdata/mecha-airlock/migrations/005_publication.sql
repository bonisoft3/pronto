-- The publication the cluster's sync reads and its identity step extends,
-- which mecha's own stack opens over its demo tables.
CREATE PUBLICATION electric_publication_default WITH (publish_generated_columns = stored);
ALTER PUBLICATION electric_publication_default OWNER TO electric;
