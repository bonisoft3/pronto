CREATE ROLE generation_writer;
CREATE TABLE generation_head (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  generation bigint NOT NULL CHECK (generation >= 0)
);
INSERT INTO generation_head VALUES (true, 0);
CREATE TABLE accounts (id bigint PRIMARY KEY, value bigint NOT NULL);
CREATE TABLE totals (id bigint PRIMARY KEY, value bigint NOT NULL);
CREATE TABLE generation_receipts (
  generation bigint PRIMARY KEY,
  payload jsonb NOT NULL,
  digest text NOT NULL,
  outcome text NOT NULL CHECK (outcome IN ('activated', 'superseded'))
);
CREATE TABLE local_hooks (generation bigint PRIMARY KEY REFERENCES generation_receipts);

CREATE FUNCTION publish_generation(p_scope text, p_generation bigint, p_payload jsonb, p_digest text)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  head bigint;
  receipt public.generation_receipts%ROWTYPE;
  outcome text;
  part jsonb;
  row_value jsonb;
BEGIN
  IF p_scope IS DISTINCT FROM 'accounts/v1/source-1' OR p_generation IS NULL OR p_generation <= 0 THEN
    RAISE EXCEPTION 'invalid fixed scope or generation';
  END IF;
  IF p_payload IS NULL OR jsonb_typeof(p_payload) <> 'object'
     OR NOT (p_payload ?& ARRAY['accounts', 'totals'])
     OR (p_payload - ARRAY['accounts', 'totals']) <> '{}'::jsonb THEN
    RAISE EXCEPTION 'complete two-table envelope required';
  END IF;
  FOREACH part IN ARRAY ARRAY[p_payload->'accounts', p_payload->'totals'] LOOP
    IF jsonb_typeof(part) <> 'array' THEN RAISE EXCEPTION 'table must be array'; END IF;
    FOR row_value IN SELECT value FROM jsonb_array_elements(part) LOOP
      IF jsonb_typeof(row_value) <> 'object'
         OR NOT (row_value ?& ARRAY['id', 'value'])
         OR row_value - ARRAY['id', 'value'] <> '{}'::jsonb
         OR jsonb_typeof(row_value->'id') <> 'number'
         OR jsonb_typeof(row_value->'value') <> 'number'
         OR (row_value->>'id') !~ '^-?[0-9]+$'
         OR (row_value->>'value') !~ '^-?[0-9]+$' THEN
        RAISE EXCEPTION 'invalid integer result row';
      END IF;
    END LOOP;
  END LOOP;
  IF p_digest IS DISTINCT FROM encode(sha256(convert_to(p_payload::text, 'UTF8')), 'hex') THEN
    RAISE EXCEPTION 'manifest digest mismatch';
  END IF;
  SELECT generation INTO head FROM public.generation_head WHERE singleton FOR UPDATE;
  SELECT * INTO receipt FROM public.generation_receipts WHERE generation = p_generation;
  IF FOUND THEN
    IF receipt.payload <> p_payload OR receipt.digest <> p_digest THEN
      RAISE EXCEPTION 'generation identity reused with different payload';
    END IF;
    RETURN receipt.outcome;
  END IF;
  outcome := CASE WHEN p_generation > head THEN 'activated' ELSE 'superseded' END;
  INSERT INTO public.generation_receipts VALUES (p_generation, p_payload, p_digest, outcome);
  IF outcome = 'activated' THEN
    DELETE FROM public.accounts;
    INSERT INTO public.accounts SELECT * FROM jsonb_to_recordset(p_payload->'accounts') AS t(id bigint, value bigint);
    DELETE FROM public.totals;
    INSERT INTO public.totals SELECT * FROM jsonb_to_recordset(p_payload->'totals') AS t(id bigint, value bigint);
    UPDATE public.generation_head SET generation = p_generation WHERE singleton;
    INSERT INTO public.local_hooks VALUES (p_generation);
  END IF;
  RETURN outcome;
END $$;
REVOKE ALL ON FUNCTION publish_generation(text, bigint, jsonb, text) FROM PUBLIC;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO generation_writer;
GRANT SELECT ON generation_head, accounts, totals, generation_receipts, local_hooks TO generation_writer;
GRANT EXECUTE ON FUNCTION publish_generation(text, bigint, jsonb, text) TO generation_writer;

CREATE TABLE generation_ingress (
  scope text PRIMARY KEY,
  generation bigint NOT NULL,
  payload text NOT NULL,
  digest text NOT NULL
);
CREATE FUNCTION activate_ingress() RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, public AS $$
BEGIN
  PERFORM public.publish_generation(NEW.scope, NEW.generation, NEW.payload::jsonb, NEW.digest);
  RETURN NULL;
END $$;
CREATE TRIGGER activate_generation AFTER INSERT OR UPDATE ON generation_ingress
FOR EACH ROW EXECUTE FUNCTION activate_ingress();
GRANT SELECT, INSERT, UPDATE ON generation_ingress TO generation_writer;
