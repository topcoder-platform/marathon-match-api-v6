-- Drop any FK constraints on phaseConfig.marathonMatchConfigId to avoid
-- environment-specific constraint-name mismatches.
DO $$
DECLARE
  constraint_record record;
BEGIN
  FOR constraint_record IN
    SELECT c.conname
    FROM pg_constraint c
      JOIN pg_class t
        ON t.oid = c.conrelid
      JOIN pg_namespace n
        ON n.oid = t.relnamespace
      JOIN pg_attribute a
        ON a.attrelid = t.oid
       AND a.attnum = ANY(c.conkey)
    WHERE c.contype = 'f'
      AND n.nspname = 'marathon_match'
      AND t.relname = 'phaseConfig'
      AND a.attname = 'marathonMatchConfigId'
  LOOP
    EXECUTE format(
      'ALTER TABLE "marathon_match"."phaseConfig" DROP CONSTRAINT %I',
      constraint_record.conname
    );
  END LOOP;
END
$$;

-- Recreate nanoid() without pgcrypto dependency so migration works in DBs
-- where gen_random_bytes() is unavailable.
CREATE OR REPLACE FUNCTION nanoid(size int DEFAULT 14)
RETURNS text AS $$
DECLARE
  id text := '';
  i int := 0;
  urlAlphabet char(64) := 'ModuleSymbhasOwnPr-0123456789ABCDEFGHNRVfgctiUvz_KqYTJkLxpZXIjQW';
  randomHex text;
  byteValue int;
BEGIN
  IF size IS NULL OR size < 1 THEN
    RAISE EXCEPTION 'nanoid size must be >= 1';
  END IF;

  WHILE i < size LOOP
    randomHex := md5(random()::text || clock_timestamp()::text || i::text);
    byteValue := ('x' || substr(randomHex, 1, 2))::bit(8)::int;
    id := id || substr(urlAlphabet, (byteValue & 63) + 1, 1);
    i := i + 1;
  END LOOP;

  RETURN id;
END
$$ LANGUAGE PLPGSQL VOLATILE;

-- DropIndex
DROP INDEX IF EXISTS "marathon_match"."marathonMatchConfig_id_idx";

-- Drop the existing primary key regardless of its name.
DO $$
DECLARE
  primary_key_name text;
BEGIN
  SELECT c.conname
  INTO primary_key_name
  FROM pg_constraint c
    JOIN pg_class t
      ON t.oid = c.conrelid
    JOIN pg_namespace n
      ON n.oid = t.relnamespace
  WHERE c.contype = 'p'
    AND n.nspname = 'marathon_match'
    AND t.relname = 'marathonMatchConfig'
  LIMIT 1;

  IF primary_key_name IS NOT NULL THEN
    EXECUTE format(
      'ALTER TABLE "marathon_match"."marathonMatchConfig" DROP CONSTRAINT %I',
      primary_key_name
    );
  END IF;
END
$$;

-- Rename old primary key column to challengeId.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'marathon_match'
      AND table_name = 'marathonMatchConfig'
      AND column_name = 'id'
  )
  AND NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'marathon_match'
      AND table_name = 'marathonMatchConfig'
      AND column_name = 'challengeId'
  ) THEN
    ALTER TABLE "marathon_match"."marathonMatchConfig"
    RENAME COLUMN "id" TO "challengeId";
  END IF;
END
$$;

-- Add new nanoid primary key column.
ALTER TABLE "marathon_match"."marathonMatchConfig"
ADD COLUMN IF NOT EXISTS "id" VARCHAR(14);

UPDATE "marathon_match"."marathonMatchConfig"
SET "id" = nanoid()
WHERE "id" IS NULL;

ALTER TABLE "marathon_match"."marathonMatchConfig"
ALTER COLUMN "id" SET NOT NULL,
ALTER COLUMN "id" SET DEFAULT nanoid();

-- Recreate primary key on new id and enforce challenge-level uniqueness.
ALTER TABLE "marathon_match"."marathonMatchConfig"
ADD CONSTRAINT "marathonMatchConfig_pkey" PRIMARY KEY ("id");

CREATE UNIQUE INDEX IF NOT EXISTS "marathonMatchConfig_challengeId_key"
ON "marathon_match"."marathonMatchConfig"("challengeId");

-- Remap phaseConfig foreign keys from old challenge ID values to new config IDs.
UPDATE "marathon_match"."phaseConfig" AS pc
SET "marathonMatchConfigId" = mm."id"
FROM "marathon_match"."marathonMatchConfig" AS mm
WHERE pc."marathonMatchConfigId" = mm."challengeId";

ALTER TABLE "marathon_match"."phaseConfig"
ALTER COLUMN "marathonMatchConfigId" TYPE VARCHAR(14);

-- Restore foreign key to new marathonMatchConfig.id.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint c
      JOIN pg_class t
        ON t.oid = c.conrelid
      JOIN pg_namespace n
        ON n.oid = t.relnamespace
    WHERE c.contype = 'f'
      AND n.nspname = 'marathon_match'
      AND t.relname = 'phaseConfig'
      AND c.conname = 'phaseConfig_marathonMatchConfigId_fkey'
  ) THEN
    ALTER TABLE "marathon_match"."phaseConfig"
    ADD CONSTRAINT "phaseConfig_marathonMatchConfigId_fkey"
    FOREIGN KEY ("marathonMatchConfigId")
    REFERENCES "marathon_match"."marathonMatchConfig"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END
$$;
