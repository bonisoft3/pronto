// The PostgREST domain-representation functions are intentionally adjacent to
// their domains. PostgreSQL itself does not apply casts to domains; PostgREST
// discovers these casts and invokes the registered functions at its boundary.

export type DecimalProfile = Readonly<{ precision: number; scale: number }>;

const decimalName = ({ precision, scale }: DecimalProfile) => `portable_decimal_${precision}_${scale}`;

function validateProfiles(profiles: readonly DecimalProfile[]): DecimalProfile[] {
  const seen = new Set<string>();
  const valid: DecimalProfile[] = [];
  for (const { precision, scale } of profiles) {
    if (!Number.isInteger(precision) || !Number.isInteger(scale) || precision < 1 || precision > 38 || scale < 0 || scale > precision) {
      throw new Error(`decimal profile must have 1 <= precision <= 38 and 0 <= scale <= precision; got (${precision}, ${scale})`);
    }
    const key = `${precision}:${scale}`;
    if (seen.has(key)) continue;
    seen.add(key);
    valid.push({ precision, scale });
  }
  return valid.sort((a, b) => a.precision - b.precision || a.scale - b.scale);
}

// Bare, though it is the one statement here that cannot be restated: Postgres
// has no CREATE DOMAIN IF NOT EXISTS, dropping one is not an option (DROP
// DOMAIN ... CASCADE takes every column that carries it), and the only
// idempotent spelling puts the CREATE inside a DO block that swallows
// duplicate_object.
//
// That spelling was measured and rejected. A statement inside a DO block is
// invisible to squawk — a rename, a dropped column and a dropped table hidden
// in one produce no findings at all, where the same three bare produce eight.
// Buying re-appliability with a blind spot is the wrong trade for the file that
// defines every type the schema uses: a domain whose CHECK drifts is exactly
// what the checks are for. Applying this twice fails, loudly and inside the
// migration's transaction, until a migration ledger makes running it twice
// something nobody asks for.
const domain = (name: string, base: string, check: string) => `CREATE DOMAIN public.${name} AS ${base} CHECK (VALUE IS NULL OR COALESCE((${check}), false));`;

const representation = (name: string, jsonIn: string, textIn: string, jsonOut: string, jsonNull = false) => `
CREATE OR REPLACE FUNCTION public.${name}_from_json(value json)
RETURNS public.${name}
LANGUAGE sql IMMUTABLE ${jsonNull ? "CALLED ON NULL INPUT" : "STRICT"} PARALLEL SAFE
RETURN ${jsonIn};

CREATE OR REPLACE FUNCTION public.${name}_from_text(value text)
RETURNS public.${name}
LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE
RETURN ${textIn};

CREATE OR REPLACE FUNCTION public.${name}_to_json(value public.${name})
RETURNS json
LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE
RETURN ${jsonOut};

CREATE CAST (json AS public.${name}) WITH FUNCTION public.${name}_from_json(json) AS IMPLICIT;
CREATE CAST (text AS public.${name}) WITH FUNCTION public.${name}_from_text(text) AS IMPLICIT;
CREATE CAST (public.${name} AS json) WITH FUNCTION public.${name}_to_json(public.${name}) AS IMPLICIT;`;

/**
 * Base type DDL. `generateTypeSQL` appends the only parameterized
 * types: decimal domains whose precision and scale are declared by fields.
 */
export const TYPE_SQL = String.raw`-- portable type domains for PostgreSQL 18 and PostgREST 12.2.3
--
-- This migration is deliberately one-shot. Domains cannot be altered safely
-- into a different type contract, so a changed type is a new migration.
SET search_path = public, pg_catalog;

CREATE OR REPLACE FUNCTION public.portable_json_scalar_text(value json, expected text)
RETURNS text
LANGUAGE plpgsql IMMUTABLE STRICT PARALLEL SAFE
AS $$
BEGIN
  IF json_typeof(value) <> expected THEN
    RAISE EXCEPTION 'expected JSON %, got %', expected, json_typeof(value) USING ERRCODE = '22023';
  END IF;
  RETURN value #>> '{}';
END;
$$;

CREATE OR REPLACE FUNCTION public.portable_canonical_integer(value text, lo bigint, hi bigint)
RETURNS boolean
LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE
RETURN value ~ '^(0|-?[1-9][0-9]*)$' AND value::numeric >= lo AND value::numeric <= hi;

CREATE OR REPLACE FUNCTION public.portable_reject(message text)
RETURNS text
LANGUAGE plpgsql VOLATILE PARALLEL SAFE
AS $$
BEGIN
  RAISE EXCEPTION '%', message USING ERRCODE = '22023';
END;
$$;

CREATE OR REPLACE FUNCTION public.portable_finite_double(value double precision)
RETURNS boolean
LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE
RETURN value <> 'Infinity'::double precision
  AND value <> '-Infinity'::double precision
  AND value <> 'NaN'::double precision;

CREATE OR REPLACE FUNCTION public.portable_base64(value text)
RETURNS boolean
LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE
RETURN value ~ '^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$';

CREATE OR REPLACE FUNCTION public.portable_timezone(value text)
RETURNS boolean
LANGUAGE sql STABLE STRICT PARALLEL SAFE
RETURN (value = 'UTC' OR value LIKE '%/%')
  AND EXISTS (SELECT 1 FROM pg_timezone_names WHERE name = value);

CREATE OR REPLACE FUNCTION public.portable_duration_valid(value interval)
RETURNS boolean
LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE
RETURN extract(month FROM value) = 0
  AND extract(year FROM value) = 0
  AND extract(day FROM value) = 0
  AND value >= interval '0 seconds'
  AND extract(epoch FROM value) <= 315576000000::numeric;

CREATE OR REPLACE FUNCTION public.portable_decimal_valid(value numeric, digits integer, fraction_digits integer)
RETURNS boolean
LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE
RETURN value = trunc(value, fraction_digits)
  AND abs(value) < power(10::numeric, digits - fraction_digits);

CREATE OR REPLACE FUNCTION public.portable_json_number_valid(value json)
RETURNS boolean
LANGUAGE plpgsql IMMUTABLE STRICT PARALLEL SAFE
AS $$
DECLARE binary64 double precision;
DECLARE source numeric;
BEGIN
  IF json_typeof(value) <> 'number' THEN RETURN false; END IF;
  BEGIN
    source := (value #>> '{}')::numeric;
    binary64 := source::double precision;
  EXCEPTION WHEN numeric_value_out_of_range OR invalid_text_representation THEN
    RETURN false;
  END;
  RETURN portable_finite_double(binary64) AND source = binary64::text::numeric;
END;
$$;

CREATE OR REPLACE FUNCTION public.portable_json_valid(value json)
RETURNS boolean
LANGUAGE plpgsql IMMUTABLE STRICT PARALLEL SAFE
AS $$
DECLARE item json;
BEGIN
  CASE json_typeof(value)
    WHEN 'number' THEN RETURN portable_json_number_valid(value);
    WHEN 'array' THEN
      FOR item IN SELECT json_array_elements(value) LOOP
        IF portable_json_valid(item) IS NOT TRUE THEN RETURN false; END IF;
      END LOOP;
    WHEN 'object' THEN
      IF EXISTS (SELECT entry.key FROM json_each($1) AS entry GROUP BY entry.key HAVING count(*) > 1) THEN RETURN false; END IF;
      FOR item IN SELECT entry.value FROM json_each($1) AS entry LOOP
        IF portable_json_valid(item) IS NOT TRUE THEN RETURN false; END IF;
      END LOOP;
    WHEN 'string' THEN
      BEGIN
        PERFORM value #>> '{}';
      EXCEPTION WHEN character_not_in_repertoire OR invalid_text_representation THEN
        RETURN false;
      END;
      RETURN true;
    WHEN 'boolean', 'null' THEN RETURN true;
    ELSE RETURN false;
  END CASE;
  RETURN true;
END;
$$;

CREATE OR REPLACE FUNCTION public.portable_geojson_position_valid(value json)
RETURNS boolean
LANGUAGE plpgsql IMMUTABLE STRICT PARALLEL SAFE
AS $$
DECLARE longitude double precision;
DECLARE latitude double precision;
BEGIN
  IF json_typeof(value) IS DISTINCT FROM 'array' OR json_array_length(value) NOT IN (2, 3) THEN RETURN false; END IF;
  IF portable_json_number_valid(value -> 0) IS NOT TRUE OR portable_json_number_valid(value -> 1) IS NOT TRUE THEN RETURN false; END IF;
  IF json_array_length(value) = 3 AND portable_json_number_valid(value -> 2) IS NOT TRUE THEN RETURN false; END IF;
  longitude := (value ->> 0)::double precision;
  latitude := (value ->> 1)::double precision;
  RETURN longitude BETWEEN -180 AND 180 AND latitude BETWEEN -90 AND 90;
END;
$$;

CREATE OR REPLACE FUNCTION public.portable_geojson_positions_valid(value json, minimum integer)
RETURNS boolean
LANGUAGE plpgsql IMMUTABLE STRICT PARALLEL SAFE
AS $$
DECLARE item json;
BEGIN
  IF json_typeof(value) IS DISTINCT FROM 'array' OR json_array_length(value) < minimum THEN RETURN false; END IF;
  FOR item IN SELECT json_array_elements(value) LOOP
    IF portable_geojson_position_valid(item) IS NOT TRUE THEN RETURN false; END IF;
  END LOOP;
  RETURN true;
END;
$$;

CREATE OR REPLACE FUNCTION public.portable_geojson_ring_valid(value json)
RETURNS boolean
LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE
RETURN COALESCE(portable_geojson_positions_valid(value, 4)
  AND ((value -> 0 ->> 0)::numeric = (value -> (json_array_length(value) - 1) ->> 0)::numeric)
  AND ((value -> 0 ->> 1)::numeric = (value -> (json_array_length(value) - 1) ->> 1)::numeric), false);

CREATE OR REPLACE FUNCTION public.portable_geojson_geometry_valid(value json)
RETURNS boolean
LANGUAGE plpgsql IMMUTABLE STRICT PARALLEL SAFE
AS $$
DECLARE kind text;
DECLARE coordinates json;
DECLARE item json;
BEGIN
  IF json_typeof(value) IS DISTINCT FROM 'object' OR json_object_field(value, 'crs') IS NOT NULL THEN RETURN false; END IF;
  kind := value ->> 'type';
  CASE kind
    WHEN 'Point' THEN RETURN portable_geojson_position_valid(value -> 'coordinates');
    WHEN 'MultiPoint' THEN RETURN portable_geojson_positions_valid(value -> 'coordinates', 0);
    WHEN 'LineString' THEN RETURN portable_geojson_positions_valid(value -> 'coordinates', 2);
    WHEN 'MultiLineString' THEN
      coordinates := value -> 'coordinates';
      IF json_typeof(coordinates) IS DISTINCT FROM 'array' THEN RETURN false; END IF;
      FOR item IN SELECT json_array_elements(coordinates) LOOP
        IF portable_geojson_positions_valid(item, 2) IS NOT TRUE THEN RETURN false; END IF;
      END LOOP;
      RETURN true;
    WHEN 'Polygon' THEN
      coordinates := value -> 'coordinates';
      IF json_typeof(coordinates) IS DISTINCT FROM 'array' OR json_array_length(coordinates) = 0 THEN RETURN false; END IF;
      FOR item IN SELECT json_array_elements(coordinates) LOOP
        IF portable_geojson_ring_valid(item) IS NOT TRUE THEN RETURN false; END IF;
      END LOOP;
      RETURN true;
    WHEN 'MultiPolygon' THEN
      coordinates := value -> 'coordinates';
      IF json_typeof(coordinates) IS DISTINCT FROM 'array' THEN RETURN false; END IF;
      FOR item IN SELECT json_array_elements(coordinates) LOOP
        IF json_typeof(item) IS DISTINCT FROM 'array' OR json_array_length(item) = 0 THEN RETURN false; END IF;
        IF EXISTS (SELECT 1 FROM json_array_elements(item) AS ring WHERE portable_geojson_ring_valid(ring) IS NOT TRUE) THEN RETURN false; END IF;
      END LOOP;
      RETURN true;
    WHEN 'GeometryCollection' THEN
      coordinates := value -> 'geometries';
      IF json_typeof(coordinates) IS DISTINCT FROM 'array' THEN RETURN false; END IF;
      FOR item IN SELECT json_array_elements(coordinates) LOOP
        IF portable_geojson_geometry_valid(item) IS NOT TRUE THEN RETURN false; END IF;
      END LOOP;
      RETURN true;
    ELSE RETURN false;
  END CASE;
END;
$$;

CREATE OR REPLACE FUNCTION public.portable_geojson_valid(value json)
RETURNS boolean
LANGUAGE plpgsql IMMUTABLE STRICT PARALLEL SAFE
AS $$
DECLARE item json;
DECLARE properties json;
BEGIN
  IF json_typeof(value) IS DISTINCT FROM 'object' THEN RETURN false; END IF;
  CASE value ->> 'type'
    WHEN 'Feature' THEN
      properties := value -> 'properties';
      RETURN json_object_field(value, 'geometry') IS NOT NULL
        AND json_object_field(value, 'properties') IS NOT NULL
        AND json_typeof(properties) IN ('object', 'null')
        AND (json_typeof(value -> 'geometry') = 'null' OR portable_geojson_geometry_valid(value -> 'geometry') IS TRUE);
    WHEN 'FeatureCollection' THEN
      IF json_object_field(value, 'features') IS NULL OR json_typeof(value -> 'features') IS DISTINCT FROM 'array' THEN RETURN false; END IF;
      FOR item IN SELECT json_array_elements(value -> 'features') LOOP
        IF portable_geojson_valid(item) IS NOT TRUE OR item ->> 'type' IS DISTINCT FROM 'Feature' THEN RETURN false; END IF;
      END LOOP;
      RETURN true;
    ELSE RETURN portable_geojson_geometry_valid(value);
  END CASE;
END;
$$;

${domain("portable_string", "text", "true")}
${domain("portable_bool", "boolean", "true")}
${domain("portable_int32", "integer", "true")}
${domain("portable_int64", "bigint", "true")}
${domain("portable_double", "double precision", "portable_finite_double(VALUE)")}
${domain("portable_bytes", "bytea", "true")}
${domain("portable_uuid", "uuid", "true")}
${domain("portable_timestamp", "timestamptz", "VALUE >= timestamptz '0001-01-01 00:00:00+00' AND VALUE < timestamptz '10000-01-01 00:00:00+00'")}
${domain("portable_date", "date", "VALUE >= date '0001-01-01' AND VALUE < date '10000-01-01'")}
${domain("portable_time", "time(6)", "VALUE < time '24:00:00'")}
${domain("portable_timezone", "text", "portable_timezone(VALUE)")}
${domain("portable_duration", "interval", "portable_duration_valid(VALUE)")}
${domain("portable_json", "json", "portable_json_valid(VALUE)")}
${domain("portable_geojson", "json", "portable_json_valid(VALUE) AND portable_geojson_valid(VALUE)")}

${representation("portable_string", "portable_json_scalar_text(value, 'string')::public.portable_string", "value::public.portable_string", "to_json(value::text)")}
${representation("portable_bool", "portable_json_scalar_text(value, 'boolean')::boolean::public.portable_bool", "CASE value WHEN 'true' THEN true WHEN 'false' THEN false ELSE portable_reject('portable_bool must be true or false')::boolean END::public.portable_bool", "to_json(value::boolean)")}
${representation("portable_int32", "CASE WHEN portable_canonical_integer(portable_json_scalar_text(value, 'number'), -2147483648, 2147483647) THEN portable_json_scalar_text(value, 'number')::integer ELSE portable_reject('portable_int32 must be a canonical JSON integer')::integer END::public.portable_int32", "CASE WHEN portable_canonical_integer(value, -2147483648, 2147483647) THEN value::integer ELSE portable_reject('portable_int32 must be canonical')::integer END::public.portable_int32", "to_json(value::integer)")}
${representation("portable_int64", "CASE WHEN portable_canonical_integer(portable_json_scalar_text(value, 'string'), -9223372036854775808, 9223372036854775807) THEN portable_json_scalar_text(value, 'string')::bigint ELSE portable_reject('portable_int64 must be a canonical JSON string')::bigint END::public.portable_int64", "CASE WHEN portable_canonical_integer(value, -9223372036854775808, 9223372036854775807) THEN value::bigint ELSE portable_reject('portable_int64 must be canonical')::bigint END::public.portable_int64", "to_json(value::text)")}
${representation("portable_double", "portable_json_scalar_text(value, 'number')::double precision::public.portable_double", "value::double precision::public.portable_double", "to_json(value::double precision)")}
${representation("portable_bytes", "CASE WHEN portable_base64(portable_json_scalar_text(value, 'string')) THEN decode(portable_json_scalar_text(value, 'string'), 'base64') ELSE portable_reject('portable_bytes must be strict base64')::bytea END::public.portable_bytes", "CASE WHEN portable_base64(value) THEN decode(value, 'base64') ELSE portable_reject('portable_bytes must be strict base64')::bytea END::public.portable_bytes", "to_json(replace(encode(value::bytea, 'base64'), E'\\n', ''))")}
${representation("portable_uuid", "CASE WHEN portable_json_scalar_text(value, 'string') ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN portable_json_scalar_text(value, 'string')::uuid ELSE portable_reject('portable_uuid must be lowercase and hyphenated')::uuid END::public.portable_uuid", "CASE WHEN value ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN value::uuid ELSE portable_reject('portable_uuid must be lowercase and hyphenated')::uuid END::public.portable_uuid", "to_json(lower(value::uuid::text))")}
${representation("portable_timestamp", "CASE WHEN portable_json_scalar_text(value, 'string') ~ '^[0-9]{4}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])T([01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9]\\.[0-9]{6}Z$' THEN portable_json_scalar_text(value, 'string')::timestamptz ELSE portable_reject('portable_timestamp must be UTC with exactly six fractional digits')::timestamptz END::public.portable_timestamp", "CASE WHEN value ~ '^[0-9]{4}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])T([01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9]\\.[0-9]{6}Z$' THEN value::timestamptz ELSE portable_reject('portable_timestamp must be UTC with exactly six fractional digits')::timestamptz END::public.portable_timestamp", `to_json(to_char(value::timestamptz AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'))`)}
${representation("portable_date", "CASE WHEN portable_json_scalar_text(value, 'string') ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' THEN portable_json_scalar_text(value, 'string')::date ELSE portable_reject('portable_date must be RFC 3339 full-date')::date END::public.portable_date", "CASE WHEN value ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' THEN value::date ELSE portable_reject('portable_date must be RFC 3339 full-date')::date END::public.portable_date", "to_json(to_char(value::date, 'YYYY-MM-DD'))")}
${representation("portable_time", "CASE WHEN portable_json_scalar_text(value, 'string') ~ '^[0-9]{2}:[0-9]{2}:[0-9]{2}\\.[0-9]{6}$' AND portable_json_scalar_text(value, 'string') < '24:00:00.000000' THEN portable_json_scalar_text(value, 'string')::time ELSE portable_reject('portable_time must be HH:mm:ss.ffffff before 24:00')::time END::public.portable_time", "CASE WHEN value ~ '^[0-9]{2}:[0-9]{2}:[0-9]{2}\\.[0-9]{6}$' AND value < '24:00:00.000000' THEN value::time ELSE portable_reject('portable_time must be HH:mm:ss.ffffff before 24:00')::time END::public.portable_time", "to_json(to_char(value::time, 'HH24:MI:SS.US'))")}
${representation("portable_timezone", "portable_json_scalar_text(value, 'string')::public.portable_timezone", "value::public.portable_timezone", "to_json(value::text)")}
${representation("portable_duration", "CASE WHEN portable_json_scalar_text(value, 'string') ~ '^PT(0|[1-9][0-9]*)(\\.[0-9]{0,5}[1-9])?S$' THEN (substring(portable_json_scalar_text(value, 'string') FROM 3 FOR char_length(portable_json_scalar_text(value, 'string')) - 3) || ' seconds')::interval ELSE portable_reject('portable_duration must be canonical total seconds at microsecond precision')::interval END::public.portable_duration", "CASE WHEN value ~ '^PT(0|[1-9][0-9]*)(\\.[0-9]{0,5}[1-9])?S$' THEN (substring(value FROM 3 FOR char_length(value) - 3) || ' seconds')::interval ELSE portable_reject('portable_duration must be canonical total seconds at microsecond precision')::interval END::public.portable_duration", "to_json('PT' || trim_scale(extract(epoch FROM value::interval))::text || 'S')")}
${representation("portable_json", "COALESCE(value, 'null'::json)::public.portable_json", "value::json::public.portable_json", "value::json", true)}
${representation("portable_geojson", "value::public.portable_geojson", "value::json::public.portable_geojson", "value::json")}
`;

function decimalRepresentation(profile: DecimalProfile): string {
  const name = decimalName(profile);
  const { precision, scale } = profile;
  const pattern = scale === 0
    ? "^(0|-?[1-9][0-9]*)$"
    : `^(0|-?[1-9][0-9]*|-?(0|[1-9][0-9]*)\\.[0-9]{0,${scale - 1}}[1-9])$`;
  const parse = `CASE WHEN value ~ '${pattern}' THEN value::numeric ELSE portable_reject('portable decimal must be canonical')::numeric END`;
  return `
${domain(name, "numeric", `portable_decimal_valid(VALUE, ${precision}, ${scale})`)}
${representation(name,
  `${parse.replaceAll("value", "portable_json_scalar_text(value, 'string')")}::public.${name}`,
  `${parse}::public.${name}`,
  `to_json(trim_scale(value::numeric)::text)`)}
`;
}

export const CARRIER_SQL = TYPE_SQL;

export function generateTypeSQL(decimalProfiles: readonly DecimalProfile[] = []): string {
  const decimal = validateProfiles(decimalProfiles).map(decimalRepresentation).join("\n");
  return `${TYPE_SQL}${decimal}\n`;
}

export const generateCarrierSQL = generateTypeSQL;

